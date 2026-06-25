"use client";

// WYSIWYG email editor (Tiptap). The whole point of this component is that what
// you see here is EXACTLY what subscribers receive: it is configured to produce
// only the tags in the render.ts sanitizer allowlist, so sanitizeHtml() is a
// no-op on its output. Anything the allowlist would strip (strikethrough, code
// blocks, styles, classes, divs) is simply not offered.
//
// Interaction model (no persistent toolbar — a "floating" editor):
//   - Select text → a floating formatting bar appears (bold/italic/headings/link
//     + AI rewrite). This is the primary way to style existing text.
//   - Land on an empty line → a floating "+" insert menu appears (headings,
//     lists, quote, image, divider, and personalization merge tags). This is how
//     you add new blocks, the way people now expect from Notion/Linear/etc.
import { createContext, useContext, useEffect, useId, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { BubbleMenu, FloatingMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Placeholder } from "@tiptap/extensions";
import {
  Bold,
  Italic,
  Underline,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Link2,
  Link2Off,
  Quote,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { OrbitLoader } from "@/components/ui/orbit-loader";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";

// `insert` is the exact token dropped into the body. Name tags carry a fallback
// (after `|`) so an empty field never renders as "Hi ," — first name falls back
// to a friendly greeting word; last name drops cleanly to nothing. Email is
// always present, so it needs no fallback.
export type MergeTag = { label: string; insert: string };

const MERGE_TAGS: MergeTag[] = [
  { label: "First name", insert: "{{first_name|there}}" },
  { label: "Last name", insert: "{{last_name}}" },
  { label: "Email", insert: "{{email}}" },
];

// The personalization tags offered by the insert menu. Defaults to the built-in
// set; a campaign can extend it with the audience's custom fields via
// <MergeTagsProvider> so {{custom_field}} tags are one click away.
const MergeTagsContext = createContext<MergeTag[]>(MERGE_TAGS);

export function MergeTagsProvider({
  extra,
  children,
}: {
  extra: MergeTag[];
  children: React.ReactNode;
}) {
  // De-dupe by insert token so a custom field that happens to match a built-in
  // (e.g. first_name) doesn't show twice.
  const seen = new Set(MERGE_TAGS.map((t) => t.insert));
  const tags = [...MERGE_TAGS];
  for (const t of extra) {
    if (!seen.has(t.insert)) {
      seen.add(t.insert);
      tags.push(t);
    }
  }
  return <MergeTagsContext.Provider value={tags}>{children}</MergeTagsContext.Provider>;
}

// Shared look for both floating surfaces: a frosted, elevated pill that reads as
// "floating above" the canvas rather than docked chrome.
const floatingBarClass =
  "z-50 flex items-center gap-1 rounded-xl border border-border bg-background p-1.5 shadow-lg";

// Cross-editor focus coordination. When several RichTextEditors live side by side
// (every section column is its own editor), only the one the user is actually in
// should show a floating bar. Each editor reports its focus to a shared store; the
// menus are *rendered* only for the active editor, so the others' bars are removed
// from the DOM the instant focus moves — Tiptap's own shouldShow only re-runs on
// the editor's own transactions, so per-editor gating alone can leave a stale bar.
type EditorFocusContextValue = {
  activeId: string | null;
  setActive: (id: string) => void;
};

const EditorFocusContext = createContext<EditorFocusContextValue | null>(null);

// Wrap a group of RichTextEditors to enforce "only one floating bar at a time".
// Without this provider a lone editor still works — it just treats itself as always
// active (the single-editor case needs no coordination).
export function RichTextEditorGroup({ children }: { children: React.ReactNode }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  return (
    <EditorFocusContext.Provider value={{ activeId, setActive: setActiveId }}>
      {children}
    </EditorFocusContext.Provider>
  );
}

export type RichTextEditorProps = {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  /** When provided, a select-to-rewrite bubble menu is shown. Returns new text. */
  onRewrite?: (text: string, action: string) => Promise<string>;
  /** Horizontal alignment of the prose (mirrors the section's cell `align` at send).
   *  Applied on the wrapper so text-align cascades into the .d3-prose content. */
  align?: "left" | "center" | "right";
  className?: string;
};

function ToolbarButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={label}
            data-active={active ? "true" : undefined}
            disabled={disabled}
            // Keep the editor's selection alive while clicking floating controls.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClick}
            className="text-muted-foreground [&_svg]:size-[18px] data-[active=true]:bg-muted data-[active=true]:text-foreground"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-6 w-px self-center bg-border" />;
}

// Link dialog: add/edit/remove a link on the current selection. Controlled by the
// parent so it can be opened from the floating selection bar.
function LinkDialog({
  editor,
  open,
  onOpenChange,
}: {
  editor: Editor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [url, setUrl] = useState("");

  // Seed the field with any existing link each time the dialog opens.
  useEffect(() => {
    if (open) setUrl(editor.getAttributes("link").href ?? "");
  }, [open, editor]);

  function apply() {
    const href = url.trim();
    if (!href) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a link</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="link-url">Link URL</Label>
          <Input
            id="link-url"
            placeholder="https://example.com"
            value={url}
            autoFocus
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                apply();
              }
            }}
          />
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button type="button" onClick={apply}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RichTextEditor({
  value,
  onChange,
  placeholder,
  onRewrite,
  align,
  className,
}: RichTextEditorProps) {
  const focusGroup = useContext(EditorFocusContext);
  const mergeTags = useContext(MergeTagsContext);
  const editorId = useId();
  // No provider → a lone editor → always active. With a provider, this editor is
  // active only while it (last) held focus, so its floating bars render alone.
  const isActive = !focusGroup || focusGroup.activeId === editorId;

  const [rewriting, setRewriting] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  // AI rewrite-by-prompt: the user selects text, opens this, and describes the
  // change they want. The selection is captured on open (focus moves to the
  // dialog input, so the live editor selection is no longer reliable at submit).
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiSelection, setAiSelection] = useState<
    { from: number; to: number; text: string } | null
  >(null);

  const editor = useEditor({
    immediatelyRender: false, // SSR safety in Next
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // Disabled because their tags are NOT in the sanitizer allowlist (strike)
        // or add noise without value for newsletters (code / code blocks).
        strike: false,
        code: false,
        codeBlock: false,
        // Off because it force-appends an empty paragraph after any non-paragraph
        // block (e.g. a heading) and re-adds it the instant you delete it — so
        // turning text into a title left an undeletable blank line below it.
        trailingNode: false,
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: "https",
          HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
        },
      }),
      Image.configure({ inline: false, allowBase64: false }),
      Placeholder.configure({
        placeholder: placeholder ?? "Write your email…",
      }),
    ],
    content: value || "",
    editorProps: {
      attributes: {
        class: "d3-prose focus:outline-none",
      },
    },
    onUpdate: ({ editor }) => {
      onChange(editor.isEmpty ? "" : editor.getHTML());
    },
  });

  // Sync external value changes (e.g. an AI draft) into the editor without
  // emitting an update (which would loop). Normalize the empty case: an empty
  // Tiptap doc serializes to "<p></p>", so compare against that to avoid a churn
  // loop when value is "".
  useEffect(() => {
    if (!editor) return;
    const incoming = value && value.trim() ? value : "<p></p>";
    if (incoming !== editor.getHTML()) {
      editor.commands.setContent(incoming, { emitUpdate: false });
    }
  }, [value, editor]);

  // Claim "active editor" on focus so any other editor's floating bar unmounts.
  useEffect(() => {
    if (!editor || !focusGroup) return;
    const claim = () => focusGroup.setActive(editorId);
    editor.on("focus", claim);
    return () => {
      editor.off("focus", claim);
    };
  }, [editor, focusGroup, editorId]);

  // Snapshot the current selection and open the "edit with AI" prompt.
  function openAiRewrite() {
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    if (empty) return;
    const text = editor.state.doc.textBetween(from, to, " ").trim();
    if (!text) return;
    setAiSelection({ from, to, text });
    setAiPrompt("");
    setAiOpen(true);
  }

  // Send the captured selection + the user's instruction to the rewrite endpoint,
  // then swap the result in over the original range.
  async function submitAiRewrite() {
    const sel = aiSelection;
    const instruction = aiPrompt.trim();
    if (!editor || !onRewrite || !sel || !instruction || rewriting) return;
    setRewriting(true);
    try {
      const result = await onRewrite(sel.text, instruction);
      if (result) {
        editor
          .chain()
          .focus()
          .setTextSelection({ from: sel.from, to: sel.to })
          .deleteSelection()
          .insertContent(result)
          .run();
      }
      setAiOpen(false);
    } finally {
      setRewriting(false);
    }
  }

  if (!editor) {
    return (
      <div
        className={cn(
          "flex min-h-[320px] items-center justify-center rounded-xl border border-border bg-card",
          className,
        )}
      >
        <OrbitLoader size={20} className="text-muted-foreground" />
      </div>
    );
  }

  const linkActive = editor.isActive("link");
  const alignClass =
    align === "center" ? "text-center" : align === "right" ? "text-right" : undefined;

  return (
    <TooltipProvider delay={300}>
      <div
        className={cn(
          "overflow-hidden rounded-xl border border-border bg-card",
          alignClass,
          className,
        )}
      >
        {/* Render the floating bars only for the active editor, so two columns can
            never show a bar at once. */}
        {isActive && (
          <>
        {/* Floating selection bar — appears whenever text is selected. Holds inline
            formatting, block "turn into" actions, links, and AI rewrite. Appended
            to <body> so the editor's overflow-hidden wrapper never clips it. */}
        <BubbleMenu
          editor={editor}
          // Gate on focus, not just a non-empty selection. Each section column is
          // its own editor, and ProseMirror keeps its selection after blur — so
          // without the focus check, clicking from one column into another would
          // leave the first column's bar still showing alongside the second's. Only
          // one editor can hold DOM focus, so requiring focus keeps a single bar.
          shouldShow={({ editor: e }) => e.isFocused && !e.state.selection.empty}
          appendTo={() => document.body}
          options={{ strategy: "fixed", placement: "top", offset: 8 }}
          className={floatingBarClass}
        >
          <ToolbarButton
            label="Bold"
            active={editor.isActive("bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold />
          </ToolbarButton>
          <ToolbarButton
            label="Italic"
            active={editor.isActive("italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic />
          </ToolbarButton>
          <ToolbarButton
            label="Underline"
            active={editor.isActive("underline")}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          >
            <Underline />
          </ToolbarButton>
          <Divider />
          <ToolbarButton
            label="Heading 1"
            active={editor.isActive("heading", { level: 1 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          >
            <Heading1 />
          </ToolbarButton>
          <ToolbarButton
            label="Heading 2"
            active={editor.isActive("heading", { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            <Heading2 />
          </ToolbarButton>
          <ToolbarButton
            label="Quote"
            active={editor.isActive("blockquote")}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          >
            <Quote />
          </ToolbarButton>
          <Divider />
          <ToolbarButton label="Link" active={linkActive} onClick={() => setLinkOpen(true)}>
            <Link2 />
          </ToolbarButton>
          {linkActive && (
            <ToolbarButton
              label="Remove link"
              onClick={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()}
            >
              <Link2Off />
            </ToolbarButton>
          )}
          {onRewrite && (
            <>
              <Divider />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-1 font-medium text-primary"
                onMouseDown={(e) => e.preventDefault()}
                onClick={openAiRewrite}
              >
                <Sparkles className="size-3.5" />
                Edit with AI
              </Button>
            </>
          )}
        </BubbleMenu>

        {/* Floating insert menu — appears on an empty line. The modern "+" that
            adds new blocks and personalization without a docked toolbar. */}
        <FloatingMenu
          editor={editor}
          appendTo={() => document.body}
          options={{ strategy: "fixed", placement: "bottom-start", offset: 6 }}
          className={floatingBarClass}
        >
          <ToolbarButton
            label="Heading 1"
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          >
            <Heading1 />
          </ToolbarButton>
          <ToolbarButton
            label="Heading 2"
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            <Heading2 />
          </ToolbarButton>
          <ToolbarButton
            label="Heading 3"
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          >
            <Heading3 />
          </ToolbarButton>
          <Divider />
          <ToolbarButton
            label="Bulleted list"
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            <List />
          </ToolbarButton>
          <ToolbarButton
            label="Numbered list"
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            <ListOrdered />
          </ToolbarButton>
          <ToolbarButton
            label="Quote"
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          >
            <Quote />
          </ToolbarButton>
          <Divider />
          <span className="pl-1 text-sm font-medium text-muted-foreground">Personalize</span>
          {mergeTags.map((t) => (
            <Button
              key={t.label}
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor.chain().focus().insertContent(t.insert).run()}
            >
              {t.label}
            </Button>
          ))}
        </FloatingMenu>
          </>
        )}

        <EditorContent editor={editor} />
      </div>

      <LinkDialog editor={editor} open={linkOpen} onOpenChange={setLinkOpen} />

      <Dialog open={aiOpen} onOpenChange={(o) => !rewriting && setAiOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              Edit with AI
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="ai-prompt">What would you like to change?</Label>
            <Input
              id="ai-prompt"
              placeholder="e.g. make this punchier and add a clear call to action"
              value={aiPrompt}
              autoFocus
              disabled={rewriting}
              onChange={(e) => setAiPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submitAiRewrite();
                }
              }}
            />
            {aiSelection?.text && (
              <p className="line-clamp-2 text-xs text-muted-foreground">
                Editing: &ldquo;{aiSelection.text}&rdquo;
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={rewriting} />}>
              Cancel
            </DialogClose>
            <Button
              type="button"
              onClick={() => void submitAiRewrite()}
              disabled={!aiPrompt.trim() || rewriting}
            >
              {rewriting ? <OrbitLoader size={16} /> : <Sparkles className="size-4" />}
              Rewrite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
