"use client";

// WYSIWYG email editor (Tiptap). The whole point of this component is that what
// you see here is EXACTLY what subscribers receive: it is configured to produce
// only the tags in the render.ts sanitizer allowlist, so sanitizeHtml() is a
// no-op on its output. Anything the allowlist would strip (strikethrough, code
// blocks, styles, classes, divs) is simply not offered.
import { useCallback, useEffect, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
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
  ImageIcon,
  Quote,
  Minus,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Select-to-rewrite actions. Defined here (not imported from services/ai, which
// is server-only and would pull the AI SDK into the client bundle).
const REWRITE_OPTIONS: { action: string; label: string }[] = [
  { action: "improve", label: "Improve" },
  { action: "shorten", label: "Shorten" },
  { action: "friendly", label: "Friendlier" },
  { action: "grammar", label: "Fix grammar" },
];

const MERGE_TAGS: { value: string; label: string }[] = [
  { value: "first_name", label: "First name" },
  { value: "last_name", label: "Last name" },
  { value: "email", label: "Email" },
];

export type RichTextEditorProps = {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  /** When provided, a select-to-rewrite bubble menu is shown. Returns new text. */
  onRewrite?: (text: string, action: string) => Promise<string>;
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
            size="icon-sm"
            aria-label={label}
            data-active={active ? "true" : undefined}
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClick}
            className="text-muted-foreground data-[active=true]:bg-muted data-[active=true]:text-foreground"
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
  return <span aria-hidden className="mx-0.5 h-5 w-px self-center bg-border" />;
}

// Link dialog: add/edit/remove a link on the current selection.
function LinkDialog({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");

  function openDialog() {
    setUrl(editor.getAttributes("link").href ?? "");
    setOpen(true);
  }
  function apply() {
    const href = url.trim();
    if (!href) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    setOpen(false);
  }

  const hasLink = editor.isActive("link");
  return (
    <>
      <ToolbarButton label="Link" active={hasLink} onClick={openDialog}>
        <Link2 />
      </ToolbarButton>
      {hasLink && (
        <ToolbarButton
          label="Remove link"
          onClick={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()}
        >
          <Link2Off />
        </ToolbarButton>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
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
    </>
  );
}

// Image dialog: insert an image by URL (with alt text). No base64/uploads — email
// images must be hosted, and the sanitizer only keeps src/alt/width/height.
function ImageDialog({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [alt, setAlt] = useState("");

  function insert() {
    const src = url.trim();
    if (!src) return;
    editor.chain().focus().setImage({ src, alt: alt.trim() || undefined }).run();
    setOpen(false);
    setUrl("");
    setAlt("");
  }

  return (
    <>
      <ToolbarButton label="Image" onClick={() => setOpen(true)}>
        <ImageIcon />
      </ToolbarButton>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Insert an image</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="img-url">Image URL</Label>
              <Input
                id="img-url"
                placeholder="https://example.com/image.png"
                value={url}
                autoFocus
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="img-alt">Alt text (optional)</Label>
              <Input
                id="img-alt"
                placeholder="Describe the image"
                value={alt}
                onChange={(e) => setAlt(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button type="button" onClick={insert} disabled={!url.trim()}>
              Insert
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function RichTextEditor({
  value,
  onChange,
  placeholder,
  onRewrite,
  className,
}: RichTextEditorProps) {
  const [rewriting, setRewriting] = useState<string | null>(null);

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

  const runRewrite = useCallback(
    async (action: string) => {
      if (!editor || !onRewrite) return;
      const { from, to, empty } = editor.state.selection;
      if (empty) return;
      const selected = editor.state.doc.textBetween(from, to, " ").trim();
      if (!selected) return;
      setRewriting(action);
      try {
        const result = await onRewrite(selected, action);
        if (result) {
          editor.chain().focus().deleteSelection().insertContent(result).run();
        }
      } finally {
        setRewriting(null);
      }
    },
    [editor, onRewrite],
  );

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

  return (
    <TooltipProvider delay={300}>
      <div className={cn("overflow-hidden rounded-xl border border-border bg-card", className)}>
        <div className="flex flex-wrap items-center gap-0.5 border-b border-border bg-muted/30 p-1.5">
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
            label="Heading 3"
            active={editor.isActive("heading", { level: 3 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          >
            <Heading3 />
          </ToolbarButton>
          <Divider />
          <ToolbarButton
            label="Bulleted list"
            active={editor.isActive("bulletList")}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            <List />
          </ToolbarButton>
          <ToolbarButton
            label="Numbered list"
            active={editor.isActive("orderedList")}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            <ListOrdered />
          </ToolbarButton>
          <ToolbarButton
            label="Quote"
            active={editor.isActive("blockquote")}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          >
            <Quote />
          </ToolbarButton>
          <Divider />
          <LinkDialog editor={editor} />
          <ImageDialog editor={editor} />
          <ToolbarButton
            label="Divider"
            onClick={() => editor.chain().focus().setHorizontalRule().run()}
          >
            <Minus />
          </ToolbarButton>
          <Divider />
          {/* Merge tags — Select used as an insert menu (value reset to null so the
              trigger always shows the placeholder). */}
          <Select
            value={null}
            onValueChange={(v) => {
              if (v) editor.chain().focus().insertContent(`{{${v}}}`).run();
            }}
          >
            <SelectTrigger size="sm" className="h-7 gap-1 text-xs text-muted-foreground">
              <SelectValue placeholder="Personalize" />
            </SelectTrigger>
            <SelectContent>
              {MERGE_TAGS.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {onRewrite && (
          // Appended to <body> with a fixed strategy so the menu is never clipped
          // by the editor's overflow-hidden wrapper (it would be by default, since
          // the plugin otherwise mounts into the editor's DOM parent).
          <BubbleMenu
            editor={editor}
            shouldShow={({ editor: e }) => !e.state.selection.empty}
            appendTo={() => document.body}
            options={{ strategy: "fixed", placement: "top", offset: 8 }}
            className="z-50 flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-md"
          >
            <span className="flex items-center gap-1 pr-1 pl-1.5 text-xs font-medium text-muted-foreground">
              <Sparkles className="size-3 text-primary" />
              AI
            </span>
            {REWRITE_OPTIONS.map((opt) => (
              <Button
                key={opt.action}
                type="button"
                variant="ghost"
                size="xs"
                disabled={rewriting !== null}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runRewrite(opt.action)}
              >
                {rewriting === opt.action ? <OrbitLoader size={16} /> : opt.label}
              </Button>
            ))}
          </BubbleMenu>
        )}

        <EditorContent editor={editor} />
      </div>
    </TooltipProvider>
  );
}
