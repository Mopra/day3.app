"use client";

// The campaign body builder. The body is an ordered list of *sections*, each laid
// out as 1, 2, or 3 equal-width columns. A section is either *text* (each column is
// the allowlist-locked RichTextEditor) or *image* (each column is one uploaded
// image that fills the column). Sections can be added, duplicated, removed, and
// drag-reordered. Every column's output is email-safe; the section list is
// serialized to layout tables for htmlBody (see lib/sections.ts).
//
// Controlled exactly like RichTextEditor: `value` is the section array, `onChange`
// fires with the next array on any edit (content, columns, type, image,
// add/duplicate/remove, reorder).
import { useId, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ChevronDown,
  Columns2,
  Copy,
  GripHorizontal,
  GripVertical,
  Image as ImageIcon,
  Link as LinkIcon,
  Minus,
  MousePointerClick,
  PaintBucket,
  PanelLeft,
  PanelRight,
  PanelTop,
  Pencil,
  Plus,
  Quote,
  Share2,
  StretchHorizontal,
  Trash2,
  Type,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  canvasHasTransparency,
  chooseEmailEncoding,
  compressImageForEmail,
  extForEncoding,
} from "@/lib/image-compress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OrbitLoader } from "@/components/ui/orbit-loader";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RichTextEditor, RichTextEditorGroup } from "@/components/ui/rich-text-editor";
import {
  DEFAULT_BUTTON_BG,
  DEFAULT_BUTTON_TEXT,
  DEFAULT_QUOTE_BG,
  DEFAULT_SPACER_HEIGHT,
  MAX_SECTIONS,
  MAX_SPACER_HEIGHT,
  MIN_SPACER_HEIGHT,
  SOCIAL_LABELS,
  columnPixelWidth,
  duplicateSection,
  emptySection,
  resizeSection,
  setSectionKind,
  type CampaignSection,
  type CardLayout,
  type ColumnCount,
  type SectionAlign,
  type SectionButton,
  type SectionImage,
  type SectionKind,
  type SocialItem,
  type SocialNetwork,
} from "@/lib/sections";

const COLUMN_CHOICES: ColumnCount[] = [1, 2, 3];

// Opt every section out of dnd-kit's post-drop FLIP "layout change" animation.
// That animation derives its transform as scaleX = oldWidth/newWidth and
// scaleY = oldHeight/newHeight (see @dnd-kit/sortable useDerivedTransform), and
// CSS.Transform.toString always appends those scales. Because our sections have
// *variable heights* (a short 1-column text section vs. a tall 3-column one, and
// the RichTextEditor re-measuring its contenteditable between frames), the
// old/new rects frequently differ, so the ratios come out ≠ 1 and the section
// visibly squishes/stretches on drop — intermittently, only when the swapped
// sections differ in size. Returning false skips that FLIP entirely; the live
// displacement during the drag (strategy transform, scale fixed at 1) stays
// smooth, so reordering just snaps cleanly into place on drop.
const animateLayoutChanges = () => false;

const KIND_CHOICES: { value: SectionKind; label: string; Icon: typeof Type }[] = [
  { value: "text", label: "Text", Icon: Type },
  { value: "image", label: "Image", Icon: ImageIcon },
  { value: "button", label: "Button", Icon: MousePointerClick },
  { value: "card", label: "Image + text", Icon: Columns2 },
  { value: "quote", label: "Quote", Icon: Quote },
  { value: "divider", label: "Divider", Icon: Minus },
  { value: "social", label: "Social links", Icon: Share2 },
];

// Kinds that use the 1/2/3 column layout (so the column picker shows). The rest are
// single-column and hide it.
const COLUMN_KINDS = new Set<SectionKind>(["text", "image", "button"]);

// Kinds whose content can be horizontally aligned left/center/right from the section
// toolbar. Text aligns its prose; a button row positions its button(s). (Image fills
// its column; social/card/quote carry their own alignment affordances.)
const ALIGNABLE_KINDS = new Set<SectionKind>(["text", "button"]);

// The default horizontal alignment per kind when a section has none set: a button row
// centers; text reads left.
function defaultAlign(kind: SectionKind): SectionAlign {
  return kind === "button" ? "center" : "left";
}

// Fill palette for buttons / callouts — the brand color first, then a spread of
// accents and neutrals. The label color is a simpler light/dark choice (a colored
// fill almost always wants white or near-black text).
// The brand trio leads (espresso default, then caramel and clay), and the wider
// spread stays: these swatches dress the *sender's* email, not day3's UI, and
// their brand is not ours — narrowing this to warm neutrals would be us
// choosing for them.
const FILL_SWATCHES = [
  DEFAULT_BUTTON_BG, "#b98145", "#a35f45", "#7c3aed", "#db2777",
  "#dc2626", "#ea580c", "#16a34a", "#0891b2", "#6b7280", "#ffffff",
];
// Soft tints for a callout's background, plus "no fill".
const QUOTE_SWATCHES = [
  DEFAULT_QUOTE_BG, "#f5ede0", "#eff6ff", "#f0fdf4", "#fef2f2", "#fefce8", "#faf5ff", "transparent",
];
// Section block backgrounds: "no fill" first (the default — section sits on the
// content background), then soft neutrals/tints and one dark for contrast blocks.
const SECTION_BG_SWATCHES = [
  "transparent", "#f9fafb", "#f4f4f5", "#eff6ff", "#f0fdf4",
  "#fef2f2", "#fefce8", "#faf5ff", "#111827",
];
const LABEL_DARK = "#111827";

const SOCIAL_NETWORKS = Object.keys(SOCIAL_LABELS) as SocialNetwork[];

const ALIGN_CHOICES: { value: SectionAlign; Icon: typeof Type; label: string }[] = [
  { value: "left", Icon: AlignLeft, label: "Left" },
  { value: "center", Icon: AlignCenter, label: "Center" },
  { value: "right", Icon: AlignRight, label: "Right" },
];

const CARD_LAYOUTS: { value: CardLayout; Icon: typeof Type; label: string }[] = [
  { value: "image-left", Icon: PanelLeft, label: "Image left" },
  { value: "image-right", Icon: PanelRight, label: "Image right" },
  { value: "image-top", Icon: PanelTop, label: "Image on top" },
];

// Reads a chosen file's natural pixel dimensions client-side, so the serializer can
// emit aspect-correct width/height attributes (and never upscale). Best-effort —
// the caller treats a failure as "dimensions unknown".
function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image"));
    };
    img.src = url;
  });
}

// Bounds for the draggable image-section height (px).
const MIN_IMAGE_SECTION_HEIGHT = 60;
const MAX_IMAGE_SECTION_HEIGHT = 800;

// Cover-crops the image at `sourceUrl` to exactly boxWidth × boxHeight and returns it
// as a File ready to upload. This is how an image "fills the section" at an arbitrary
// height in the *delivered* email: email clients don't support CSS object-fit, so we
// bake the crop into the bytes (centered, never upscaled beyond the box). Photos
// re-encode to JPEG to keep the email light; images with real transparency stay PNG
// (see chooseEmailEncoding). Fetching the bytes and decoding via createImageBitmap
// keeps the canvas untainted (Supabase public objects send CORS).
async function cropImageToBox(sourceUrl: string, boxWidth: number, boxHeight: number): Promise<File> {
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error("Could not load the image to crop");
  const bitmap = await createImageBitmap(await res.blob());
  try {
    const scale = Math.max(boxWidth / bitmap.width, boxHeight / bitmap.height);
    const drawW = bitmap.width * scale;
    const drawH = bitmap.height * scale;
    const canvas = document.createElement("canvas");
    canvas.width = boxWidth;
    canvas.height = boxHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not supported");
    ctx.drawImage(bitmap, (boxWidth - drawW) / 2, (boxHeight - drawH) / 2, drawW, drawH);
    const encoding = chooseEmailEncoding(canvasHasTransparency(ctx, boxWidth, boxHeight));
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(
        resolve,
        encoding.type,
        encoding.type === "image/jpeg" ? encoding.quality : undefined,
      ),
    );
    if (!blob) throw new Error("Could not crop the image");
    const ext = extForEncoding(encoding);
    return new File([blob], `image.${ext}`, { type: encoding.type });
  } finally {
    bitmap.close();
  }
}

export type SectionEditorProps = {
  value: CampaignSection[];
  onChange: (sections: CampaignSection[]) => void;
  /** Passed through to each column's editor (select-to-rewrite). */
  onRewrite?: (text: string, instruction: string) => Promise<string>;
  /** Uploads an image and resolves to its public URL (embedded as <img src>). */
  onUploadImage: (file: File) => Promise<string>;
  /** Placeholder for the very first column of the first section. */
  placeholder?: string;
  className?: string;
};

// The 1 / 2 / 3 column picker for a section — a small segmented control.
function ColumnPicker({
  value,
  onChange,
}: {
  value: ColumnCount;
  onChange: (columns: ColumnCount) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Columns"
      className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5"
    >
      {COLUMN_CHOICES.map((n) => (
        <button
          key={n}
          type="button"
          aria-label={`${n} ${n === 1 ? "column" : "columns"}`}
          aria-pressed={value === n}
          onClick={() => onChange(n)}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded text-xs font-medium tabular-nums transition-colors",
            value === n
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

// The section-type picker — a dropdown menu (there are now seven kinds, too many for
// a segmented control). Switching preserves content/uploads/buttons across the change
// (see setSectionKind), so flipping kind never loses work.
function KindPicker({
  value,
  onChange,
}: {
  value: SectionKind;
  onChange: (kind: SectionKind) => void;
}) {
  const current = KIND_CHOICES.find((k) => k.value === value) ?? KIND_CHOICES[0];
  const CurrentIcon = current.Icon;
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`Section type: ${current.label}`}
            className="flex h-6 items-center gap-1 rounded-md bg-muted/60 px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          />
        }
      >
        <CurrentIcon className="size-3.5 text-muted-foreground" />
        {current.label}
        <ChevronDown className="size-3 text-muted-foreground" />
      </MenuTrigger>
      <MenuContent align="start" className="min-w-44">
        {KIND_CHOICES.map(({ value: v, label, Icon }) => (
          <MenuItem
            key={v}
            onClick={() => onChange(v)}
            className={cn(v === value && "bg-muted/60")}
          >
            <Icon className="size-4" />
            {label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

// A generic icon segmented control (used for alignment and card layout).
function SegmentedIcons<T extends string>({
  value,
  onChange,
  choices,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  choices: { value: T; Icon: typeof Type; label: string }[];
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5"
    >
      {choices.map(({ value: v, Icon, label: l }) => (
        <button
          key={v}
          type="button"
          aria-label={l}
          aria-pressed={value === v}
          title={l}
          onClick={() => onChange(v)}
          className={cn(
            "flex size-6 items-center justify-center rounded transition-colors",
            value === v
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}

// A row of color swatches. The active swatch gets a ring; "transparent" renders as a
// checkered chip. Only emits validated colors (the swatch values themselves), so the
// serializer/sanitizer round-trip always holds.
function ColorSwatches({
  value,
  onChange,
  swatches,
  label,
}: {
  value: string | undefined;
  onChange: (color: string) => void;
  swatches: string[];
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
      {swatches.map((c) => {
        const active = (value ?? swatches[0]) === c;
        const transparent = c === "transparent";
        return (
          <button
            key={c}
            type="button"
            aria-label={c}
            aria-pressed={active}
            title={c}
            onClick={() => onChange(c)}
            style={transparent ? undefined : { backgroundColor: c }}
            className={cn(
              "size-5 rounded-full border border-foreground/40 transition-transform hover:scale-110",
              transparent &&
                "bg-[linear-gradient(45deg,#ccc_25%,transparent_25%,transparent_75%,#ccc_75%),linear-gradient(45deg,#ccc_25%,transparent_25%,transparent_75%,#ccc_75%)] bg-[length:8px_8px] bg-[position:0_0,4px_4px]",
              active && "ring-2 ring-foreground/40 ring-offset-1 ring-offset-background",
            )}
          />
        );
      })}
    </div>
  );
}

// The section background-color control in the floating toolbar: a small swatch
// button that opens a popover of background tints. Reuses ColorSwatches so the chosen
// value is always a validated swatch. Picking "transparent" clears the field (the
// section returns to sitting directly on the content background).
function SectionBgPicker({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (color: string | undefined) => void;
}) {
  const active = !!value && value !== "transparent";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Section background color"
            title="Background color"
            className="flex h-6 items-center gap-1 rounded-md bg-muted/60 px-2 text-foreground transition-colors hover:bg-muted"
          />
        }
      >
        <PaintBucket className="size-3.5 text-muted-foreground" />
        <span
          aria-hidden
          className="size-3 rounded-full border border-foreground/20"
          style={active ? { backgroundColor: value } : undefined}
        />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-2">
        <ColorSwatches
          value={value ?? "transparent"}
          onChange={(c) => onChange(c === "transparent" ? undefined : c)}
          swatches={SECTION_BG_SWATCHES}
          label="Section background"
        />
      </PopoverContent>
    </Popover>
  );
}

// Alt text + optional click-through link for an image, edited in a dialog launched
// from the image's hover toolbar — so these settings never take up space in the
// section body. Changes apply live (the builder autosaves), so "Done" just closes.
function ImageDetailsDialog({
  open,
  onOpenChange,
  value,
  onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: SectionImage;
  onChange: (image: SectionImage) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Image details</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="img-alt">Alt text</Label>
            <Input
              id="img-alt"
              value={value.alt ?? ""}
              onChange={(e) => onChange({ ...value, alt: e.target.value })}
              placeholder="Describe this image"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Shown if the image can&apos;t load, and read aloud by screen readers.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="img-link">Link URL</Label>
            <Input
              id="img-link"
              value={value.href ?? ""}
              onChange={(e) => onChange({ ...value, href: e.target.value || undefined })}
              placeholder="https://example.com"
            />
            <p className="text-xs text-muted-foreground">Optional — makes the image clickable.</p>
          </div>
        </div>
        <DialogFooter>
          <DialogClose render={<Button />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// One column of an image section: an upload dropzone when empty, or the image
// preview when filled. The hover toolbar (top-right) holds the alt/link details
// dialog, replace, and remove. When the section has a fixed height the image fills
// the column box (object-cover); otherwise it shows at its natural aspect. The
// preview always renders the *original* upload so live height drags reframe
// smoothly, while the email embeds the cover-cropped `src`.
function ImageColumn({
  value,
  onChange,
  onUpload,
  displayHeight,
  boxWidth,
  sectionHeight,
  fillWidth = false,
}: {
  value: SectionImage | null;
  onChange: (image: SectionImage | null) => void;
  onUpload: (file: File) => Promise<string>;
  /** Height (px) to render the box at — includes the live drag height. Null = natural. */
  displayHeight: number | null;
  /** The column's pixel width in the email, used to crop newly added images. */
  boxWidth: number;
  /** The section's committed height (px), or null. Newly added images crop to it. */
  sectionHeight: number | null;
  /** When the section has no fixed height, render the image at full width / natural
   *  height (no max-h cap) so it fills the column exactly like the email does, rather
   *  than scaling down and leaving side gaps. Used by the card (Image + text) editor. */
  fillWidth?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  async function handleFile(file: File | undefined | null) {
    if (!file) return;
    setUploading(true);
    try {
      // Downscale + re-encode oversized photos before upload so the delivered email
      // stays light (deliverability + load time). Falls back to the original on any
      // failure so an upload is never blocked by the optimization.
      const prepared = await compressImageForEmail(file).catch(() => file);
      const url = await onUpload(prepared);
      const dims = await readImageDimensions(prepared).catch(() => null);
      // Preserve any alt/link already entered (e.g. when replacing the image).
      let next: SectionImage = {
        src: url,
        originalSrc: url,
        alt: value?.alt ?? "",
        href: value?.href,
        width: dims?.width,
        height: dims?.height,
      };
      // If the section already has a fixed height, crop the new image to its box so
      // it fills the section like the others.
      if (sectionHeight) {
        try {
          const cropped = await cropImageToBox(url, boxWidth, sectionHeight);
          const croppedUrl = await onUpload(cropped);
          next = { ...next, src: croppedUrl, width: boxWidth, height: sectionHeight };
        } catch {
          // Fall back to the uncropped upload.
        }
      }
      onChange(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't upload the image");
    } finally {
      setUploading(false);
    }
  }

  const covered = displayHeight != null;
  const boxStyle = covered ? { height: `${displayHeight}px` } : undefined;
  // Render the full upload so dragging the height reframes the whole image, not a
  // previously baked crop.
  const previewSrc = value?.originalSrc ?? value?.src;

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          void handleFile(e.target.files?.[0]);
          // Reset so picking the same file again still fires onChange.
          e.target.value = "";
        }}
      />

      {value?.src ? (
        <div
          className="group/img relative overflow-hidden rounded-lg border border-border bg-muted/30"
          // Mirror the campaign's image roundness live (the canvas sets --d3-img-radius
          // from the theme); falls back to the editor's default when unset.
          style={{ ...boxStyle, borderRadius: "var(--d3-img-radius, 0.5rem)" }}
        >
          {/* A plain <img> (not next/image): the src is an arbitrary uploaded URL and
              this is just an editor preview, not optimized delivery. */}
          <img
            src={previewSrc}
            alt={value.alt || ""}
            className={cn(
              "mx-auto block w-full",
              covered
                ? "h-full object-cover"
                : fillWidth
                  ? "h-auto"
                  : "max-h-64 object-contain",
            )}
          />
          <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity group-hover/img:opacity-100 [@media(pointer:coarse)]:opacity-100">
            <button
              type="button"
              onClick={() => setDetailsOpen(true)}
              aria-label="Edit alt text and link"
              title={value.href ? "Alt text & link (linked)" : "Alt text & link"}
              className={cn(
                "flex size-7 items-center justify-center rounded-md bg-background/90 shadow-sm transition-colors hover:text-foreground",
                value.href ? "text-primary" : "text-muted-foreground",
              )}
            >
              <Pencil className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              aria-label="Replace image"
              title="Replace image"
              className="flex size-7 items-center justify-center rounded-md bg-background/90 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
            >
              {uploading ? <OrbitLoader size={14} /> : <Upload className="size-3.5" />}
            </button>
            <button
              type="button"
              onClick={() => onChange(null)}
              aria-label="Remove image"
              title="Remove image"
              className="flex size-7 items-center justify-center rounded-md bg-background/90 text-muted-foreground shadow-sm transition-colors hover:text-destructive"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void handleFile(e.dataTransfer.files?.[0]);
          }}
          disabled={uploading}
          style={boxStyle}
          className={cn(
            "flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed text-sm transition-colors",
            !covered && "aspect-[3/2]",
            dragOver
              ? "border-primary bg-primary/5 text-foreground"
              : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
          )}
        >
          {uploading ? <OrbitLoader size={20} /> : <ImageIcon className="size-6" />}
          <span className="font-medium">{uploading ? "Uploading…" : "Add image"}</span>
          {!uploading && (
            <span className="px-2 text-center text-xs text-muted-foreground/70">
              PNG, JPG, GIF or WebP · up to 5 MB
            </span>
          )}
        </button>
      )}

      {value?.src && (
        <ImageDetailsDialog
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          value={value}
          onChange={onChange}
        />
      )}
    </div>
  );
}

// A static, non-interactive snapshot of a section, rendered inside the DragOverlay
// while that section is being dragged. The overlay wrapper is sized by dnd-kit to
// the dragged node's captured rect, so this just has to fill that box with a
// faithful-looking copy — crucially WITHOUT mounting a second set of Tiptap
// editors (which would be heavy and could steal focus). Text columns render their
// already-allowlist-safe HTML directly; image columns mirror the upload preview.
function SectionPreview({ section }: { section: CampaignSection }) {
  const alignClass =
    section.align === "left" ? "justify-start" : section.align === "right" ? "justify-end" : "justify-center";
  const textAlignClass =
    section.align === "left" ? "text-left" : section.align === "right" ? "text-right" : "text-center";

  let body: ReactNode;
  switch (section.kind) {
    case "divider":
      body =
        section.line === false ? (
          <div className="rounded bg-muted/50" style={{ height: `${section.height ?? DEFAULT_SPACER_HEIGHT}px` }} />
        ) : (
          <hr className="border-t border-border" />
        );
      break;
    case "button":
      body = (
        <div className={cn("flex flex-wrap gap-2 py-1", alignClass)}>
          {Array.from({ length: section.columns }, (_, col) => {
            const b = section.buttons?.[col];
            if (!b?.label.trim()) return null;
            return (
              <span
                key={col}
                // Mirror the serialized button's roundness: it rounds to the campaign's
                // section radius (var set by the themed canvas), not a fixed Tailwind
                // radius, so the preview matches what ships.
                style={{
                  backgroundColor: b.bgColor ?? DEFAULT_BUTTON_BG,
                  color: b.textColor ?? DEFAULT_BUTTON_TEXT,
                  borderRadius: "var(--d3-section-radius, 12px)",
                }}
                className={cn(
                  "px-4 py-2 text-sm font-semibold",
                  b.fullWidth && "w-full text-center",
                )}
              >
                {b.label}
              </span>
            );
          })}
        </div>
      );
      break;
    case "quote": {
      // Mirror serializeQuote exactly: a flat shaded box with the same 16px inset as
      // the serialized cellpadding, rounded only when the quote opts in (radius from
      // the campaign theme). An unset fill defaults to the brand quote tint, like
      // pickColor does at serialize time.
      const quoteBg = section.bgColor ?? DEFAULT_QUOTE_BG;
      const quoteRounded = section.rounded === true;
      body = (
        <div
          className={cn("p-4", quoteRounded && "overflow-hidden")}
          style={{
            backgroundColor: quoteBg === "transparent" ? undefined : quoteBg,
            borderRadius: quoteRounded ? "var(--d3-section-radius, 12px)" : undefined,
          }}
        >
          {section.content[0]?.trim() ? (
            <div className="d3-prose" dangerouslySetInnerHTML={{ __html: section.content[0] }} />
          ) : (
            <div className="text-muted-foreground/40">Quote…</div>
          )}
          {section.attribution?.trim() && (
            <p className="mt-1 text-sm text-muted-foreground">— {section.attribution}</p>
          )}
        </div>
      );
      break;
    }
    case "social": {
      const items = (section.socials ?? []).filter((s) => s.url.trim());
      body = (
        <div className={cn("py-1 text-sm", textAlignClass)}>
          {section.socialIntro?.trim() ? `${section.socialIntro} ` : ""}
          {items.length ? (
            items.map((s) => SOCIAL_LABELS[s.network]).join("  ·  ")
          ) : (
            <span className="text-muted-foreground/40">Social links…</span>
          )}
        </div>
      );
      break;
    }
    case "card": {
      const image = section.images?.[0] ?? null;
      const img = image?.src ? (
        <img
          src={image.originalSrc ?? image.src}
          alt={image.alt || ""}
          className="w-full object-contain"
          style={{ borderRadius: "var(--d3-img-radius, 0.5rem)" }}
        />
      ) : (
        <div className="flex aspect-[3/2] items-center justify-center rounded-lg bg-muted/30 text-muted-foreground">
          <ImageIcon className="size-6" />
        </div>
      );
      const txt = section.content[0]?.trim() ? (
        <div className="d3-prose" dangerouslySetInnerHTML={{ __html: section.content[0] }} />
      ) : (
        <div className="text-muted-foreground/40">Text…</div>
      );
      const layout = section.layout ?? "image-left";
      body =
        layout === "image-top" ? (
          <div className="space-y-2">
            {img}
            {txt}
          </div>
        ) : (
          <div
            className={cn(
              // Match the live card editor (and the email): centered cells, 24px gutter.
              "grid items-center gap-6",
              layout === "image-right" ? "grid-cols-[3fr_2fr]" : "grid-cols-[2fr_3fr]",
            )}
          >
            {layout === "image-right" ? (
              <>
                {txt}
                {img}
              </>
            ) : (
              <>
                {img}
                {txt}
              </>
            )}
          </div>
        );
      break;
    }
    case "image":
    case "text":
    default:
      body = (
        <div
          className="grid items-start gap-2"
          style={{ gridTemplateColumns: `repeat(${section.columns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: section.columns }, (_, col) => {
            if (section.kind === "image") {
              const image = section.images?.[col] ?? null;
              const covered = section.height != null;
              const boxStyle = covered ? { height: `${section.height}px` } : undefined;
              return (
                <div
                  key={col}
                  className="overflow-hidden rounded-lg border border-border bg-muted/30"
                  style={{ ...boxStyle, borderRadius: "var(--d3-img-radius, 0.5rem)" }}
                >
                  {image?.src ? (
                    <img
                      src={image.originalSrc ?? image.src}
                      alt={image.alt || ""}
                      className={cn(
                        "mx-auto block w-full",
                        covered ? "h-full object-cover" : "max-h-64 object-contain",
                      )}
                    />
                  ) : (
                    <div
                      className={cn(
                        "flex w-full items-center justify-center text-muted-foreground",
                        !covered && "aspect-[3/2]",
                      )}
                      style={boxStyle}
                    >
                      <ImageIcon className="size-6" />
                    </div>
                  )}
                </div>
              );
            }
            const html = section.content[col]?.trim();
            return (
              // Mirror the resting text column (a borderless, transparent, full-width
              // editor — see SortableSection's RichTextEditor) so the dragged clone's
              // content keeps the exact same width and doesn't appear to reflow/zoom.
              // Honor the section's alignment too, like the live editor. Text defaults
              // to left (textAlignClass centers, which is the social-row default), so
              // only center/right are applied here.
              <div
                key={col}
                className={cn(
                  section.kind === "text" &&
                    (section.align === "center"
                      ? "text-center"
                      : section.align === "right"
                        ? "text-right"
                        : undefined),
                )}
              >
                {html ? (
                  <div className="d3-prose" dangerouslySetInnerHTML={{ __html: section.content[col] }} />
                ) : (
                  <div className="d3-prose text-muted-foreground/40">Write here…</div>
                )}
              </div>
            );
          })}
        </div>
      );
  }

  return (
    // The lift affordance (shadow/ring/raised background) only — no padding, so the
    // ring hugs the content and it fills the card edge-to-edge. (The resting section's
    // `py-1` is inter-section spacing that blends into the canvas at rest; inside the
    // clone's visible ring it would read as a gap above/below the image and text.)
    // Background tracks the themed email surface (`--d3-content-bg`, the same color the
    // resting section sits on) rather than the app chrome — otherwise a light-themed
    // email's dark text would land on the app's dark background in dark mode and become
    // invisible. Falls back to the app background when no theme var is in scope.
    <div
      className="overflow-hidden rounded-xl opacity-95 shadow-xl ring-1 ring-border"
      style={{
        backgroundColor:
          section.sectionBg && section.sectionBg !== "transparent"
            ? section.sectionBg
            : "var(--d3-content-bg, var(--background))",
      }}
    >
      {body}
    </div>
  );
}

// The fill + label color popover for a button, opened from its hover toolbar. Groups
// the fill swatches and the simple light/dark label choice into one compact panel so
// the resting button card stays clean.
function ButtonColorPopover({
  bg,
  text,
  onChange,
}: {
  bg: string;
  text: string;
  onChange: (patch: Partial<SectionButton>) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Button colors"
            title="Colors"
            className="flex size-7 items-center justify-center rounded-md bg-background/90 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
          />
        }
      >
        <PaintBucket className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto space-y-3 p-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Fill</Label>
          <ColorSwatches
            value={bg}
            onChange={(c) => onChange({ bgColor: c })}
            swatches={FILL_SWATCHES}
            label="Button fill color"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Label</Label>
          <ColorSwatches
            value={text}
            onChange={(c) => onChange({ textColor: c })}
            swatches={[DEFAULT_BUTTON_TEXT, LABEL_DARK]}
            label="Label color"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

// One call-to-action button's editor, modeled on the image column: the button itself
// is the hero (a live, real-looking preview), its label is edited inline by clicking
// the text beneath it, and a hover toolbar (top-right) holds the link + color
// controls so the resting card stays uncluttered. Always emits a button object (never
// null) once touched; an empty label/href simply doesn't serialize.
function ButtonColumn({
  value,
  onChange,
  align,
}: {
  value: SectionButton | null;
  onChange: (button: SectionButton) => void;
  /** The section's horizontal alignment — positions the button in its column. */
  align: SectionAlign;
}) {
  const hrefId = useId();
  const button: SectionButton = value ?? { label: "", href: "" };
  const bg = button.bgColor ?? DEFAULT_BUTTON_BG;
  const text = button.textColor ?? DEFAULT_BUTTON_TEXT;
  const update = (patch: Partial<SectionButton>) => onChange({ ...button, ...patch });
  const linked = !!button.href.trim();
  const hasLabel = !!button.label.trim();
  // Mirror the serializer exactly: a button ships only with BOTH a label and a link
  // (serializeButtonCell drops it otherwise). Surface that here so a half-built button
  // never silently vanishes from the preview/email — the builder stays WYSIWYG.
  const willSend = hasLabel && linked;
  // Show the button's real fill/label colors as soon as EITHER it's live, or the user
  // has explicitly picked a color — so choosing a fill gives immediate feedback. A
  // brand-new button that's neither (no chosen color, not yet live) shows a neutral
  // "draft" chip instead of a loud default fill, so it reads as a placeholder.
  const showFill =
    willSend || button.bgColor !== undefined || button.textColor !== undefined;
  const fullWidth = !!button.fullWidth;
  const alignClass =
    align === "left" ? "justify-start" : align === "right" ? "justify-end" : "justify-center";
  return (
    <div className="group/btn relative p-3">
      {/* Hover toolbar — width, colors + link, mirroring the image column's top-right
          tools. focus-within keeps it visible while a control inside is in use. */}
      <div className="absolute right-1.5 top-1.5 z-10 flex gap-1 opacity-0 transition-opacity group-hover/btn:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100">
        <button
          type="button"
          aria-label="Full-width button"
          aria-pressed={fullWidth}
          title={fullWidth ? "Full width" : "Fit to label"}
          onClick={() => update({ fullWidth: !fullWidth })}
          className={cn(
            "flex size-7 items-center justify-center rounded-md bg-background/90 shadow-sm transition-colors hover:text-foreground",
            // Neutral like the color/link controls and the image toolbar — an active
            // toggle reads as the (darker) foreground, never a brand-primary fill.
            fullWidth ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <StretchHorizontal className="size-3.5" />
        </button>
        <ButtonColorPopover bg={bg} text={text} onChange={update} />
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="Edit button link"
                title={linked ? `Linked to ${button.href.trim()}` : "Add a link"}
                className={cn(
                  "flex size-7 items-center justify-center rounded-md bg-background/90 shadow-sm transition-colors hover:text-foreground",
                  linked ? "text-foreground" : "text-muted-foreground",
                )}
              />
            }
          >
            <LinkIcon className="size-3.5" />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 space-y-1.5 p-3">
            <Label htmlFor={hrefId}>Link URL</Label>
            <Input
              id={hrefId}
              value={button.href}
              onChange={(e) => update({ href: e.target.value })}
              placeholder="https://…"
              aria-label="Button link"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">Where the button goes when clicked.</p>
          </PopoverContent>
        </Popover>
      </div>

      {/* The button — the label is edited directly on it. The chip is a <label>, so a
          click anywhere on the button focuses the input; an invisible sizer span keeps
          the input exactly as wide as its text so the chip grows/shrinks as you type
          (an input can't size to content on its own). The row honors the section's
          alignment (moot when the button is full-width). */}
      <div className={cn("flex py-1", alignClass)}>
        <label
          style={showFill ? { backgroundColor: bg === "transparent" ? undefined : bg, color: text } : undefined}
          className={cn(
            "relative cursor-text rounded-md px-4 py-2 text-sm font-semibold transition-colors",
            fullWidth ? "grid w-full" : "inline-grid",
            // No chosen color and not yet live → a quiet neutral draft chip, so it reads
            // as a placeholder rather than a loud finished CTA competing with the app's
            // own buttons.
            !showFill && "border border-dashed border-border bg-transparent text-muted-foreground",
            // Showing its real color but not yet shippable (no link) → keep the color
            // visible for feedback, just slightly dimmed to still read as not-live.
            showFill && !willSend && "opacity-70",
          )}
        >
          <span aria-hidden className="invisible col-start-1 row-start-1 whitespace-pre px-px">
            {button.label || "Button"}
          </span>
          <input
            value={button.label}
            onChange={(e) => update({ label: e.target.value })}
            placeholder="Button"
            aria-label="Button label"
            // Only force the button's own label color when the chip shows its real
            // fill; while it's a neutral draft chip the label inherits the muted color
            // (a white `text` would be invisible on the transparent placeholder).
            style={showFill ? { color: text } : undefined}
            className="col-start-1 row-start-1 w-full bg-transparent px-px text-center outline-none placeholder:text-current placeholder:opacity-60"
          />
        </label>
      </div>

      {/* Honesty hint — the serializer drops a button that lacks a label or a link, so
          warn here rather than let it silently disappear from the preview/email. */}
      {!willSend && (
        <p className="mt-1 flex items-center justify-center gap-1 text-center text-xs text-amber-600 dark:text-amber-500">
          <LinkIcon className="size-3 shrink-0" />
          {!hasLabel && !linked
            ? "Add a label and a link so this button appears in the email"
            : !linked
              ? "Add a link so this button appears in the email"
              : "Add a label so this button appears in the email"}
        </p>
      )}
    </div>
  );
}

// A two-option text segmented control (Line / Spacer).
function SegmentedText<T extends string>({
  value,
  onChange,
  choices,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  choices: { value: T; label: string }[];
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
      {choices.map(({ value: v, label: l }) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cn(
            "rounded px-2.5 py-1 text-xs font-medium transition-colors",
            value === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

// A divider's editor: choose a rule or a blank spacer, and (for a spacer) drag the
// gap. The preview mirrors what the email renders.
function DividerControls({
  line,
  height,
  onUpdate,
}: {
  line: boolean | undefined;
  height: number | undefined;
  onUpdate: (patch: Partial<CampaignSection>) => void;
}) {
  const isLine = line !== false;
  const h = Math.round(Math.max(MIN_SPACER_HEIGHT, Math.min(MAX_SPACER_HEIGHT, height ?? DEFAULT_SPACER_HEIGHT)));
  return (
    <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
      <div className="flex justify-center">
        <SegmentedText
          value={isLine ? "line" : "spacer"}
          onChange={(v) => onUpdate({ line: v === "line" })}
          choices={[
            { value: "line", label: "Line" },
            { value: "spacer", label: "Spacer" },
          ]}
          label="Divider style"
        />
      </div>
      {isLine ? (
        <hr className="border-t border-border" />
      ) : (
        <div className="space-y-2">
          <div className="rounded bg-muted/50" style={{ height: `${h}px` }} aria-hidden />
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={MIN_SPACER_HEIGHT}
              max={MAX_SPACER_HEIGHT}
              value={h}
              onChange={(e) => onUpdate({ height: Number(e.target.value) })}
              aria-label="Spacer height"
              className="w-full accent-primary"
            />
            <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{h}px</span>
          </div>
        </div>
      )}
    </div>
  );
}

// A quote / callout editor: rich text in a shaded box with an optional attribution
// line. Its settings (corner roundness + fill tint) live in a hover toolbar at the
// top-right, exactly like the image and button editors — not stacked beneath the box.
function QuoteEditor({
  section,
  onContentChange,
  onUpdate,
  onRewrite,
}: {
  section: CampaignSection;
  onContentChange: (col: number, html: string) => void;
  onUpdate: (patch: Partial<CampaignSection>) => void;
  onRewrite?: (text: string, instruction: string) => Promise<string>;
}) {
  const bg = section.bgColor ?? DEFAULT_QUOTE_BG;
  // Mirror serializeQuote: rounded only when explicitly set. The radius tracks the
  // campaign's section roundness (the same `--d3-section-radius` the email's <style>
  // resolves to t.sectionRadius), so the canvas matches what ships.
  const rounded = section.rounded === true;
  return (
    <div className="group/quote relative">
      {/* Hover toolbar — roundness + fill, mirroring the image/button top-right tools.
          focus-within keeps it visible while the color popover is open. */}
      <div className="absolute right-1.5 top-1.5 z-10 flex gap-1 opacity-0 transition-opacity group-hover/quote:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100">
        <button
          type="button"
          aria-label="Rounded corners"
          aria-pressed={rounded}
          title={rounded ? "Square corners" : "Rounded corners"}
          onClick={() => onUpdate({ rounded: !rounded })}
          className={cn(
            "flex size-7 items-center justify-center rounded-md bg-background/90 shadow-sm transition-colors hover:text-foreground",
            rounded ? "text-primary" : "text-muted-foreground",
          )}
        >
          {/* A box glyph that is rounded/square to match the toggle's state. */}
          <span
            aria-hidden
            className={cn("size-3.5 border-2 border-current", rounded ? "rounded-[5px]" : "rounded-[1px]")}
          />
        </button>
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="Callout color"
                title="Callout color"
                className="flex size-7 items-center justify-center rounded-md bg-background/90 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
              />
            }
          >
            <PaintBucket className="size-3.5" />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto p-3">
            <ColorSwatches
              value={bg}
              onChange={(c) => onUpdate({ bgColor: c })}
              swatches={QUOTE_SWATCHES}
              label="Callout color"
            />
          </PopoverContent>
        </Popover>
      </div>

      {/* A flat shaded box, matching serializeQuote (cellpadding 16 → p-4). Roundness
          comes from the campaign theme so the builder shows exactly the box that ships. */}
      <div
        className={cn("p-4", rounded && "overflow-hidden")}
        style={{
          backgroundColor: bg === "transparent" ? undefined : bg,
          borderRadius: rounded ? "var(--d3-section-radius, 12px)" : undefined,
        }}
      >
        <RichTextEditor
          value={section.content[0] ?? ""}
          onChange={(html) => onContentChange(0, html)}
          onRewrite={onRewrite}
          placeholder="A quote or a highlight worth pulling out…"
          className="border-0 bg-transparent [&_.d3-prose]:min-h-0"
        />
        <Input
          value={section.attribution ?? ""}
          onChange={(e) => onUpdate({ attribution: e.target.value })}
          placeholder="— Attribution (optional)"
          aria-label="Quote attribution"
          className="mt-1 h-8 border-0 bg-transparent px-0 text-sm text-muted-foreground shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
      </div>
    </div>
  );
}

// A social-links editor: an optional lead-in, a list of network + url rows, an add
// button, and the row alignment.
function SocialEditor({
  section,
  onUpdate,
}: {
  section: CampaignSection;
  onUpdate: (patch: Partial<CampaignSection>) => void;
}) {
  const socials = section.socials ?? [];
  const networkItems = Object.fromEntries(SOCIAL_NETWORKS.map((n) => [n, SOCIAL_LABELS[n]]));
  const setItem = (i: number, patch: Partial<SocialItem>) => {
    const next = socials.map((s, j) => (j === i ? { ...s, ...patch } : s));
    onUpdate({ socials: next });
  };
  const add = () => {
    const used = new Set(socials.map((s) => s.network));
    const next = SOCIAL_NETWORKS.find((n) => !used.has(n)) ?? "website";
    onUpdate({ socials: [...socials, { network: next, url: "" }] });
  };
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <Input
        value={section.socialIntro ?? ""}
        onChange={(e) => onUpdate({ socialIntro: e.target.value })}
        placeholder="Lead-in text, e.g. “Follow us:” (optional)"
        aria-label="Social lead-in text"
        className="h-8 text-sm"
      />
      {socials.map((s, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Select
            items={networkItems}
            value={s.network}
            onValueChange={(v) => v && setItem(i, { network: v as SocialNetwork })}
          >
            <SelectTrigger aria-label="Network" className="h-8 w-32 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOCIAL_NETWORKS.map((n) => (
                <SelectItem key={n} value={n}>
                  {SOCIAL_LABELS[n]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={s.url}
            onChange={(e) => setItem(i, { url: e.target.value })}
            placeholder={s.network === "email" ? "mailto:hi@…" : "https://…"}
            aria-label={`${SOCIAL_LABELS[s.network]} URL`}
            className="h-8 text-sm"
          />
          <button
            type="button"
            aria-label="Remove link"
            onClick={() => onUpdate({ socials: socials.filter((_, j) => j !== i) })}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-destructive"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={add}
          disabled={socials.length >= 12}
          className="text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-4" />
          Add link
        </Button>
        <SegmentedIcons
          value={section.align ?? "center"}
          onChange={(a) => onUpdate({ align: a })}
          choices={ALIGN_CHOICES}
          label="Row alignment"
        />
      </div>
    </div>
  );
}

// A card editor (one image + rich text): a layout toggle and the image/text arranged
// to mirror the chosen layout.
function CardEditor({
  section,
  onContentChange,
  onImageChange,
  onUpdate,
  onUploadImage,
  onRewrite,
}: {
  section: CampaignSection;
  onContentChange: (col: number, html: string) => void;
  onImageChange: (col: number, image: SectionImage | null) => void;
  onUpdate: (patch: Partial<CampaignSection>) => void;
  onUploadImage: (file: File) => Promise<string>;
  onRewrite?: (text: string, instruction: string) => Promise<string>;
}) {
  const layout = section.layout ?? "image-left";
  const imageEl = (
    <ImageColumn
      value={section.images?.[0] ?? null}
      onChange={(img) => onImageChange(0, img)}
      onUpload={onUploadImage}
      displayHeight={null}
      boxWidth={columnPixelWidth(1)}
      sectionHeight={null}
      fillWidth
    />
  );
  const textEl = (
    <RichTextEditor
      value={section.content[0] ?? ""}
      onChange={(html) => onContentChange(0, html)}
      onRewrite={onRewrite}
      placeholder="Write about it…"
      className="border-0 bg-transparent [&_.d3-prose]:min-h-0"
    />
  );
  return (
    <div className="space-y-2">
      <div className="flex justify-center">
        <SegmentedIcons
          value={layout}
          onChange={(l) => onUpdate({ layout: l })}
          choices={CARD_LAYOUTS}
          label="Card layout"
        />
      </div>
      {layout === "image-top" ? (
        <div className="space-y-3">
          {imageEl}
          {textEl}
        </div>
      ) : (
        <div
          className={cn(
            // items-center + a 24px gap mirror the email exactly: the card serializer
            // centers its two cells (valign="middle") and inserts a 24px gutter column,
            // so the live canvas and the delivered email stay pixel-aligned.
            "grid items-center gap-6",
            layout === "image-right" ? "grid-cols-[3fr_2fr]" : "grid-cols-[2fr_3fr]",
          )}
        >
          {layout === "image-right" ? (
            <>
              {textEl}
              {imageEl}
            </>
          ) : (
            <>
              {imageEl}
              {textEl}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SortableSection({
  section,
  isOnly,
  canDuplicate,
  placeholder,
  onRewrite,
  onUploadImage,
  onColumnsChange,
  onKindChange,
  onContentChange,
  onImageChange,
  onButtonChange,
  onUpdate,
  onResize,
  onDuplicate,
  onRemove,
}: {
  section: CampaignSection;
  isOnly: boolean;
  canDuplicate: boolean;
  placeholder?: string;
  onRewrite?: (text: string, instruction: string) => Promise<string>;
  onUploadImage: (file: File) => Promise<string>;
  onColumnsChange: (columns: ColumnCount) => void;
  onKindChange: (kind: SectionKind) => void;
  onContentChange: (columnIndex: number, html: string) => void;
  onImageChange: (columnIndex: number, image: SectionImage | null) => void;
  onButtonChange: (columnIndex: number, button: SectionButton) => void;
  onUpdate: (patch: Partial<CampaignSection>) => void;
  onResize: (height: number) => Promise<void>;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: section.id,
    animateLayoutChanges,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Image-section height drag. During the drag we only track a local height (a live,
  // smooth object-cover preview); on release we commit it, which crops each image to
  // the new box for the email. The local height is held across the async commit so
  // the box doesn't snap back to natural while the crop uploads.
  const contentRef = useRef<HTMLDivElement>(null);
  const resizeStart = useRef<{ y: number; height: number } | null>(null);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const displayHeight = dragHeight ?? section.height ?? null;

  // Per-section background fill (WYSIWYG mirror of the serialized colored band). When
  // set, the body sits in a full-bleed, color-filled band: the negative margins cancel
  // the composer content card's padding (p-6 → sm:p-10) so the fill reaches the card's
  // full width, and the matching inner padding re-insets the content — exactly what the
  // delivered email does (the body cell drops its horizontal padding and each colored
  // section bleeds full width with a cellpadding inset). Unset, the body sits flush on
  // the content background as before.
  const hasSectionBg = !!section.sectionBg && section.sectionBg !== "transparent";
  const sectionBgStyle = hasSectionBg ? { backgroundColor: section.sectionBg } : undefined;
  const sectionBgClass = hasSectionBg
    ? "-mx-6 px-6 py-6 sm:-mx-10 sm:px-10 sm:py-10"
    : undefined;

  function clampHeight(px: number): number {
    return Math.round(Math.max(MIN_IMAGE_SECTION_HEIGHT, Math.min(MAX_IMAGE_SECTION_HEIGHT, px)));
  }

  function onResizeStart(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    // Seed from the current rendered height so the drag never jumps.
    const startHeight = displayHeight ?? contentRef.current?.offsetHeight ?? 240;
    resizeStart.current = { y: e.clientY, height: startHeight };
    setDragHeight(clampHeight(startHeight));
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onResizeMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!resizeStart.current) return;
    setDragHeight(clampHeight(resizeStart.current.height + (e.clientY - resizeStart.current.y)));
  }

  async function onResizeEnd(e: ReactPointerEvent<HTMLDivElement>) {
    if (!resizeStart.current) return;
    const height = clampHeight(resizeStart.current.height + (e.clientY - resizeStart.current.y));
    resizeStart.current = null;
    setDragHeight(height); // hold the size while the images crop + upload
    try {
      await onResize(height);
    } finally {
      setDragHeight(null);
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group/section relative rounded-xl bg-transparent",
        // While dragging, this node stays put as a dimmed placeholder reserving its
        // slot — the moving visual is the fixed-size clone in the DragOverlay, so the
        // section can't distort or smear over its neighbors as it travels.
        isDragging && "opacity-40",
      )}
    >
      {/* Drag handle — pushed out past the content card's edge so it sits on the page
          background, not inside the email body. The offset clears the card's
          horizontal padding (p-4 → sm:p-10), so it lands in the page gutter at both
          breakpoints. Vertically centered; muted but always present so it stays
          tappable on touch.
          The base offset is small on purpose: the phone canvas only has ~36px of
          gutter, and a 28px control set 24px out would hang off the message
          column and give the page a horizontal scrollbar. */}
      <button
        type="button"
        aria-label="Drag to reorder section"
        className="absolute right-full top-1/2 mr-1 flex size-7 -translate-y-1/2 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground active:cursor-grabbing sm:mr-11"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>

      {/* Section actions — pushed out past the content card's edge so they sit on the
          page background (mirrors the drag handle's offset). Vertically centered as a
          group: duplicate sits just above remove. */}
      <div className="absolute left-full top-1/2 ml-1 flex -translate-y-1/2 flex-col gap-0.5 sm:ml-11">
        <button
          type="button"
          aria-label="Duplicate section"
          onClick={onDuplicate}
          disabled={!canDuplicate}
          title={
            canDuplicate
              ? "Duplicate section"
              : `A campaign can have at most ${MAX_SECTIONS} sections`
          }
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <Copy className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Remove section"
          onClick={onRemove}
          disabled={isOnly}
          title={isOnly ? "A campaign needs at least one section" : "Remove section"}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted hover:text-destructive disabled:pointer-events-none disabled:opacity-30"
        >
          <Trash2 className="size-4" />
        </button>
      </div>

      {/* Type + column pickers — float in just above the section on hover, so the
          resting body has no header. The spacing above the section is padding, not
          margin, so the pickers' hit area stays *contiguous* with the section: the
          container's box reaches all the way down to the section's top edge
          (bottom-full, no margin). Moving the cursor up to a picker therefore never
          crosses a dead gap onto the section above — which would otherwise steal the
          hover and make these disappear mid-reach. z-20 keeps them above a neighbor's
          content where the two overlap.

          focus-within is what makes these reachable on a touch screen, where
          there is no hover at all: tapping into the section (its text field,
          its button, any control) brings the pickers up. Without it the section
          type, column count, alignment and background would be desktop-only. */}
      <div className="pointer-events-none absolute bottom-full left-1/2 z-20 flex w-max max-w-[92vw] -translate-x-1/2 justify-center pb-1 opacity-0 transition-opacity group-hover/section:pointer-events-auto group-hover/section:opacity-100 group-focus-within/section:pointer-events-auto group-focus-within/section:opacity-100">
        {/* Wraps rather than overflows: four picker groups are wider than a
            phone, and this bar is centred on the section, so any overhang would
            spill past both edges of the page. */}
        <div className="flex flex-wrap items-center justify-center gap-1.5 rounded-lg border border-border bg-popover p-1 shadow-lg">
          <KindPicker value={section.kind} onChange={onKindChange} />
          {COLUMN_KINDS.has(section.kind) && (
            <ColumnPicker value={section.columns} onChange={onColumnsChange} />
          )}
          {ALIGNABLE_KINDS.has(section.kind) && (
            <SegmentedIcons
              value={section.align ?? defaultAlign(section.kind)}
              onChange={(a) => onUpdate({ align: a })}
              choices={ALIGN_CHOICES}
              label="Alignment"
            />
          )}
          <SectionBgPicker
            value={section.sectionBg}
            onChange={(c) => onUpdate({ sectionBg: c })}
          />
        </div>
      </div>

      {/* Body — column kinds (text/image/button) lay out as equal-width columns
          mirroring the email; the single-column kinds render their own editor. */}
      {COLUMN_KINDS.has(section.kind) ? (
        <div className="py-1">
          <div style={sectionBgStyle} className={sectionBgClass}>
          <div
            ref={contentRef}
            className="grid items-start gap-2"
            style={{ gridTemplateColumns: `repeat(${section.columns}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: section.columns }, (_, col) =>
              section.kind === "image" ? (
                <ImageColumn
                  key={col}
                  value={section.images?.[col] ?? null}
                  onChange={(image) => onImageChange(col, image)}
                  onUpload={onUploadImage}
                  displayHeight={displayHeight}
                  boxWidth={columnPixelWidth(section.columns)}
                  sectionHeight={section.height ?? null}
                />
              ) : section.kind === "button" ? (
                <ButtonColumn
                  key={col}
                  value={section.buttons?.[col] ?? null}
                  onChange={(button) => onButtonChange(col, button)}
                  align={section.align ?? "center"}
                />
              ) : (
                <RichTextEditor
                  key={col}
                  value={section.content[col] ?? ""}
                  onChange={(html) => onContentChange(col, html)}
                  onRewrite={onRewrite}
                  placeholder={
                    col === 0 && placeholder
                      ? placeholder
                      : section.columns > 1
                        ? "Column content…"
                        : "Write here…"
                  }
                  // Mirror the section's horizontal alignment in the live prose (the
                  // email gets it via the cell's `align` attribute). text-align
                  // cascades into the .d3-prose content.
                  align={section.align ?? "left"}
                  // min-h-0 on the editor body so each column's height follows its
                  // content instead of the editor's default tall canvas.
                  className="border-0 bg-transparent [&_.d3-prose]:min-h-0"
                />
              ),
            )}
          </div>
          </div>
        </div>
      ) : (
        <div className="py-1">
          <div style={sectionBgStyle} className={sectionBgClass}>
          {section.kind === "divider" && (
            <DividerControls line={section.line} height={section.height} onUpdate={onUpdate} />
          )}
          {section.kind === "quote" && (
            <QuoteEditor
              section={section}
              onContentChange={onContentChange}
              onUpdate={onUpdate}
              onRewrite={onRewrite}
            />
          )}
          {section.kind === "social" && <SocialEditor section={section} onUpdate={onUpdate} />}
          {section.kind === "card" && (
            <CardEditor
              section={section}
              onContentChange={onContentChange}
              onImageChange={onImageChange}
              onUpdate={onUpdate}
              onUploadImage={onUploadImage}
              onRewrite={onRewrite}
            />
          )}
          </div>
        </div>
      )}

      {/* Bottom resize handle — image sections only. Drag to set the section height;
          each image fills it (object-cover) and is cropped to that box for the email.
          Hover-revealed like the pickers; pointer-events gated to hover so it never
          steals clicks from the image/dropzone beneath it when hidden. */}
      {section.kind === "image" && (
        <div
          role="slider"
          aria-label="Image height"
          aria-orientation="vertical"
          aria-valuemin={MIN_IMAGE_SECTION_HEIGHT}
          aria-valuemax={MAX_IMAGE_SECTION_HEIGHT}
          aria-valuenow={Math.round(displayHeight ?? 0)}
          tabIndex={0}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const base = displayHeight ?? contentRef.current?.offsetHeight ?? 240;
              void onResize(clampHeight(base + (e.key === "ArrowUp" ? -16 : 16)));
            }
          }}
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex h-3 cursor-ns-resize touch-none items-center justify-center opacity-0 transition-opacity group-hover/section:pointer-events-auto group-hover/section:opacity-100 [@media(pointer:coarse)]:pointer-events-auto [@media(pointer:coarse)]:opacity-100"
        >
          <span className="flex h-4 w-10 items-center justify-center rounded-full border border-border bg-background shadow-sm">
            <GripHorizontal className="size-3 text-muted-foreground" />
          </span>
        </div>
      )}
    </div>
  );
}

// The "add a section" affordance: a full-width button that opens a popover grid of
// every section kind, so all seven types are visible at the moment of adding rather
// than hidden behind a per-section dropdown. Picking a kind appends a fresh section
// of that kind and closes the popover.
function AddSectionButton({
  onAdd,
  disabled,
}: {
  onAdd: (kind: SectionKind) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            title={disabled ? `A campaign can have at most ${MAX_SECTIONS} sections` : undefined}
            className="w-full text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Plus className="size-4" />
        Add section
      </PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-auto p-2">
        <div className="grid grid-cols-3 gap-1">
          {KIND_CHOICES.map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                onAdd(value);
                setOpen(false);
              }}
              className="flex h-16 w-20 flex-col items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Icon className="size-5" />
              {label}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function SectionEditor({
  value,
  onChange,
  onRewrite,
  onUploadImage,
  placeholder,
  className,
}: SectionEditorProps) {
  const sensors = useSensors(
    // A small drag threshold so clicks/taps inside a section (e.g. selecting text in
    // an editor) aren't swallowed as drags.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Id of the section currently being dragged, so it can be rendered in the
  // DragOverlay as a fixed-size floating clone (null when nothing is dragging).
  const [activeId, setActiveId] = useState<string | null>(null);

  // Never let the builder go empty — there's always at least one section to edit.
  const sections = value.length > 0 ? value : [emptySection()];
  const activeSection = activeId ? sections.find((s) => s.id === activeId) ?? null : null;

  function commit(next: CampaignSection[]) {
    onChange(next.length > 0 ? next : [emptySection()]);
  }

  function patchSection(id: string, updater: (s: CampaignSection) => CampaignSection) {
    commit(sections.map((s) => (s.id === id ? updater(s) : s)));
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = sections.findIndex((s) => s.id === active.id);
    const to = sections.findIndex((s) => s.id === over.id);
    if (from < 0 || to < 0) return;
    commit(arrayMove(sections, from, to));
  }

  return (
    <RichTextEditorGroup>
      <div className={cn("space-y-2", className)}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
        <SortableContext
          items={sections.map((s) => s.id)}
          strategy={verticalListSortingStrategy}
        >
          {sections.map((section, i) => (
            <SortableSection
              key={section.id}
              section={section}
              isOnly={sections.length === 1}
              canDuplicate={sections.length < MAX_SECTIONS}
              placeholder={i === 0 ? placeholder : undefined}
              onRewrite={onRewrite}
              onUploadImage={onUploadImage}
              onColumnsChange={(columns) =>
                patchSection(section.id, (s) => resizeSection(s, columns))
              }
              onKindChange={(kind) => patchSection(section.id, (s) => setSectionKind(s, kind))}
              onContentChange={(col, html) =>
                patchSection(section.id, (s) => {
                  const content = [...s.content];
                  content[col] = html;
                  return { ...s, content };
                })
              }
              onImageChange={(col, image) =>
                patchSection(section.id, (s) => {
                  // Materialize an images array sized to the columns, then set this slot.
                  const images = Array.from({ length: s.columns }, (_, idx) => s.images?.[idx] ?? null);
                  images[col] = image;
                  return { ...s, images };
                })
              }
              onButtonChange={(col, button) =>
                patchSection(section.id, (s) => {
                  // Materialize a buttons array sized to the columns, then set this slot.
                  const buttons = Array.from({ length: s.columns }, (_, idx) => s.buttons?.[idx] ?? null);
                  buttons[col] = button;
                  return { ...s, buttons };
                })
              }
              onUpdate={(patch) => patchSection(section.id, (s) => ({ ...s, ...patch }))}
              onResize={async (height) => {
                // Cover-crop every column's image to the new box (from the preserved
                // original), then commit the height + cropped images in one patch so
                // the email matches the builder. A failed crop keeps that image as-is.
                const colW = columnPixelWidth(section.columns);
                const current = Array.from(
                  { length: section.columns },
                  (_, idx) => section.images?.[idx] ?? null,
                );
                const cropped = await Promise.all(
                  current.map(async (img) => {
                    const source = img?.originalSrc ?? img?.src;
                    if (!img || !source) return img;
                    try {
                      const file = await cropImageToBox(source, colW, height);
                      const url = await onUploadImage(file);
                      return { ...img, src: url, originalSrc: source, width: colW, height };
                    } catch {
                      return img;
                    }
                  }),
                );
                patchSection(section.id, (s) => ({ ...s, height, images: cropped }));
              }}
              onDuplicate={() => {
                const next = [...sections];
                next.splice(i + 1, 0, duplicateSection(section));
                commit(next);
              }}
              onRemove={() => commit(sections.filter((s) => s.id !== section.id))}
            />
          ))}
        </SortableContext>

        {/* The floating clone of the dragged section. dnd-kit sizes this wrapper to
            the dragged node's captured rect, so the preview keeps the section's exact
            width/height instead of reflowing — which is what eliminates the
            intermittent "changes size" distortion. */}
        <DragOverlay>
          {activeSection ? <SectionPreview section={activeSection} /> : null}
        </DragOverlay>
      </DndContext>

      <AddSectionButton
        onAdd={(kind) => commit([...sections, setSectionKind(emptySection(), kind)])}
        disabled={sections.length >= MAX_SECTIONS}
      />
      </div>
    </RichTextEditorGroup>
  );
}
