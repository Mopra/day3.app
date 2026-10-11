// Merge tags as readable chips in the editor. A writer sees "First name · there"
// where the email holds {{first_name|there}}; the raw token reads as code to anyone
// who isn't a developer, and half-deleting one ("{{first_nam") silently ships a tag
// that resolves to nothing.
//
// The chip is display only. The node keeps the token exactly as typed (`raw`) and
// the editor's HTML carries that same plain text (see unwrapMergeTags), so the
// stored htmlBody, the sanitizer allowlist and the send-time renderer never see
// anything new: an email with chips is byte-identical to one without. Nothing ever parses a chip out of
// HTML either. Tokens arrive as ordinary text (loaded drafts, typing the closing
// "}}", the insert menus, AI drafts, paste) and a plugin swaps each complete one for
// a node. That is also why it needs no parseHTML rule. One undo takes back both the
// typing and the chip it produced.
//
// As an inline atom the chip behaves like one character: the cursor steps over it
// and Backspace removes the whole tag.
import { Node } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";

// Same grammar the renderer fills at send time (services/render.ts, and the
// composer's preview): a key, optional spaces, an optional "|fallback".
const TAG_RE = /\{\{\s*([a-z][a-z0-9_]*)\s*(?:\|([^}]*))?\}\}/gi;

const BUILT_IN_LABELS: Record<string, string> = {
  first_name: "First name",
  last_name: "Last name",
  email: "Email",
  company_name: "Company name",
  company_address: "Company address",
};

// "first_name|there" -> { label: "First name", fallback: "there" }.
export function mergeTagParts(raw: string): { label: string; fallback: string } {
  const m = /^\{\{\s*([a-z][a-z0-9_]*)\s*(?:\|([^}]*))?\}\}$/i.exec(raw);
  if (!m) return { label: raw, fallback: "" };
  const key = m[1].toLowerCase();
  const words = key.replace(/_/g, " ");
  const label = BUILT_IN_LABELS[key] ?? words.charAt(0).toUpperCase() + words.slice(1);
  return { label, fallback: (m[2] ?? "").trim() };
}

const scanKey = new PluginKey("mergeTagScan");

const WRAPPER_ATTR = "data-d3-tag";
const WRAPPER_RE = /<span data-d3-tag="">([^<]*)<\/span>/g;

// The editor's HTML with each chip turned back into its bare token: the exact
// string the body held before chips existed. Every reader of the editor's HTML must
// go through this, or the marker spans leak into the draft.
export function unwrapMergeTags(html: string): string {
  return html.replace(WRAPPER_RE, "$1");
}

// Replaces every complete {{token}} in a text node with a chip, keeping the text's
// marks (a bold or linked "{{first_name}}" stays bold or linked). Returns null when
// there is nothing to convert, so a no-op never dispatches.
function convertTokens(state: EditorState): Transaction | null {
  const type = state.schema.nodes.mergeTag;
  if (!type) return null;
  const found: { from: number; to: number; raw: string; node: PMNode }[] = [];
  state.doc.descendants((node, pos, parent) => {
    if (!node.isText || !node.text || !parent?.inlineContent) return;
    TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_RE.exec(node.text))) {
      found.push({ from: pos + m.index, to: pos + m.index + m[0].length, raw: m[0], node });
    }
  });
  if (found.length === 0) return null;
  const tr = state.tr;
  // Back to front, so earlier positions stay valid as later ranges change size.
  for (const f of found.reverse()) {
    tr.replaceWith(f.from, f.to, type.create({ raw: f.raw }, null, f.node.marks));
  }
  return tr;
}

export const MergeTagNode = Node.create({
  name: "mergeTag",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return { raw: { default: "" } };
  },

  // ProseMirror's serializer insists on an element, so the token is wrapped in a
  // marker span, and unwrapMergeTags strips that wrapper from every HTML the editor
  // hands out. (Pasted elsewhere it is an attribute-less span around plain text; the
  // sanitizer drops the span and keeps the token.)
  renderHTML({ node }) {
    return ["span", { [WRAPPER_ATTR]: "" }, node.attrs.raw as string];
  },

  renderText({ node }) {
    return node.attrs.raw as string;
  },

  // ProseMirror's textBetween (used by "Edit with AI" to read a selection and by the
  // "{{" trigger) reads a leaf through `leafText`; without it a chip would read as
  // nothing and a rewrite would drop the tag.
  extendNodeSchema(extension) {
    return extension.name === "mergeTag"
      ? { leafText: (node: PMNode) => node.attrs.raw as string }
      : {};
  },

  addNodeView() {
    return ({ node }) => {
      const { label, fallback } = mergeTagParts(node.attrs.raw as string);
      const dom = document.createElement("span");
      dom.className = "d3-merge-chip";
      dom.contentEditable = "false";
      dom.title = fallback
        ? `${node.attrs.raw}: shows "${fallback}" when ${label.toLowerCase()} is empty`
        : String(node.attrs.raw);
      dom.textContent = label;
      if (fallback) {
        const fb = document.createElement("span");
        fb.className = "d3-merge-chip-fallback";
        fb.textContent = ` · ${fallback}`;
        dom.appendChild(fb);
      }
      return { dom };
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: scanKey,
        // Converts tokens after any edit, and on demand (the editor dispatches a
        // scan once at creation, since initial content arrives without a transaction).
        appendTransaction(transactions, _old, state) {
          if (!transactions.some((tr) => tr.docChanged || tr.getMeta(scanKey))) return null;
          // Never re-convert what undo/redo just restored, or undoing a conversion
          // would immediately be converted back and undo would appear stuck.
          // ("history$" is prosemirror-history's plugin key.) Normal edits need no
          // such care: the history folds an appended transaction into the edit that
          // caused it, so one undo takes back the typing and the chip together.
          if (transactions.some((tr) => tr.getMeta("history$"))) return null;
          return convertTokens(state);
        },
      }),
    ];
  },
});

// Ask the plugin to convert whatever the editor was created with. Marked
// preventUpdate: it changes nothing a reader of the unwrapped HTML could see, so
// it must not fire onUpdate (that would autosave a draft just for being opened).
export function scanMergeTags(state: EditorState): Transaction {
  return state.tr.setMeta(scanKey, true).setMeta("preventUpdate", true);
}
