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
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
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
  Columns2,
  Copy,
  GripHorizontal,
  GripVertical,
  Image as ImageIcon,
  Link as LinkIcon,
  Minus,
  MousePointerClick,
  Plus,
  Quote,
  Share2,
  SlidersHorizontal,
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
import { OrbitLoader } from "@/components/ui/orbit-loader";
import {
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
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
  setSectionKind,
  type CampaignSection,
  type SectionAlign,
  type SectionButton,
  type SectionImage,
  type SectionKind,
} from "@/lib/sections";


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

export const KIND_CHOICES: { value: SectionKind; label: string; Icon: typeof Type }[] = [
  { value: "text", label: "Text", Icon: Type },
  { value: "image", label: "Image", Icon: ImageIcon },
  { value: "button", label: "Button", Icon: MousePointerClick },
  { value: "card", label: "Image + text", Icon: Columns2 },
  { value: "quote", label: "Quote", Icon: Quote },
  { value: "divider", label: "Divider", Icon: Minus },
  { value: "social", label: "Social links", Icon: Share2 },
];

// Kinds that use the 1/2/3 column layout (so the column picker shows). The rest are
// single-column.
export const COLUMN_KINDS = new Set<SectionKind>(["text", "image", "button"]);

export const KIND_LABELS = Object.fromEntries(
  KIND_CHOICES.map((k) => [k.value, k.label]),
) as Record<SectionKind, string>;


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
  /** The section the panel is editing (selection lives in the composer, which
   *  also renders the panel). */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Select a section and open the panel focused on one of its fields. */
  onEditField: (id: string, field: string) => void;
};

// One column of an image section: an upload dropzone when empty, or the image
// preview when filled. The hover toolbar (top-right) replaces or removes it; its alt
// text and link are set in the section panel. When the section has a fixed height the image fills
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
          <div className="absolute right-1.5 top-1.5 z-20 flex gap-1 opacity-0 transition-opacity group-hover/img:opacity-100 [@media(pointer:coarse)]:opacity-100">
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

// One call-to-action button on the canvas: the button itself, its label edited
// inline by clicking the text. Its link, colors and width live in the section panel
// (see section-inspector.tsx). Always emits a button object (never null) once
// touched; an empty label/href simply doesn't serialize.
function ButtonColumn({
  value,
  onChange,
  align,
  onEditLink,
}: {
  value: SectionButton | null;
  onChange: (button: SectionButton) => void;
  /** The section's horizontal alignment: positions the button in its column. */
  align: SectionAlign;
  /** Opens the section panel on this button's link field. */
  onEditLink: () => void;
}) {
  const button: SectionButton = value ?? { label: "", href: "" };
  const bg = button.bgColor ?? DEFAULT_BUTTON_BG;
  const text = button.textColor ?? DEFAULT_BUTTON_TEXT;
  const update = (patch: Partial<SectionButton>) => onChange({ ...button, ...patch });
  const linked = !!button.href.trim();
  const hasLabel = !!button.label.trim();
  // Mirror the serializer exactly: a button ships only with BOTH a label and a link
  // (serializeButtonCell drops it otherwise). Surface that here so a half-built button
  // never silently vanishes from the preview/email: the builder stays WYSIWYG.
  const willSend = hasLabel && linked;
  // Show the button's real fill/label colors as soon as EITHER it's live, or the user
  // has explicitly picked a color, so choosing a fill gives immediate feedback. A
  // brand-new button that's neither shows a neutral "draft" chip instead of a loud
  // default fill, so it reads as a placeholder.
  const showFill =
    willSend || button.bgColor !== undefined || button.textColor !== undefined;
  const fullWidth = !!button.fullWidth;
  const alignClass =
    align === "left" ? "justify-start" : align === "right" ? "justify-end" : "justify-center";
  return (
    <div className="p-3">
      {/* The button. The label is edited directly on it: the chip is a <label>, so a
          click anywhere on the button focuses the input, and an invisible sizer span
          keeps the input exactly as wide as its text so the chip grows and shrinks as
          you type. Rounded like the email's button (the campaign's section radius). */}
      <div className={cn("flex py-1", alignClass)}>
        <label
          style={{
            borderRadius: "var(--d3-section-radius, 12px)",
            ...(showFill
              ? { backgroundColor: bg === "transparent" ? undefined : bg, color: text }
              : {}),
          }}
          className={cn(
            "relative cursor-text px-4 py-2 text-sm font-semibold transition-colors",
            fullWidth ? "grid w-full" : "inline-grid",
            // No chosen color and not yet live: a quiet neutral draft chip, so it reads
            // as a placeholder rather than a finished CTA.
            !showFill && "border border-dashed border-border bg-transparent text-muted-foreground",
            // Showing its real color but not yet shippable (no link): keep the color
            // visible for feedback, slightly dimmed to still read as not live.
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
            // fill; while it's a neutral draft chip the label inherits the muted color.
            style={showFill ? { color: text } : undefined}
            className="col-start-1 row-start-1 w-full bg-transparent px-px text-center outline-none placeholder:text-current placeholder:opacity-60"
          />
        </label>
      </div>

      {/* Honesty hint: the serializer drops a button that lacks a label or a link, so
          say so here rather than let it silently disappear. A missing link is one
          click away: the hint opens the panel on the link field. */}
      {!willSend &&
        (linked ? (
          <p className="mt-1 text-center text-xs text-amber-600 dark:text-amber-500">
            Add a label so this button appears in the email
          </p>
        ) : (
          <button
            type="button"
            onClick={onEditLink}
            className="mx-auto mt-1 flex items-center gap-1 rounded text-xs text-amber-600 underline-offset-2 hover:underline dark:text-amber-500"
          >
            <LinkIcon className="size-3 shrink-0" />
            {hasLabel
              ? "Add a link so this button appears in the email"
              : "Add a label and a link so this button appears in the email"}
          </button>
        ))}
    </div>
  );
}

// A divider on the canvas, drawn the way the email draws it: a rule in the theme's
// border color with the email's 24px of air, or a blank spacer of the chosen height
// (faintly outlined here so an empty gap can still be seen and clicked). Line vs
// spacer and the height are set in the section panel.
function DividerPreview({ line, height }: { line: boolean | undefined; height: number | undefined }) {
  if (line !== false) {
    return (
      <div className="py-6">
        <hr
          className="border-0 border-t"
          style={{ borderTopColor: "var(--d3-border-color, var(--border))" }}
        />
      </div>
    );
  }
  const h = Math.round(
    Math.max(MIN_SPACER_HEIGHT, Math.min(MAX_SPACER_HEIGHT, height ?? DEFAULT_SPACER_HEIGHT)),
  );
  return (
    <div
      aria-label={`Spacer, ${h}px`}
      className="flex items-center justify-center rounded border border-dashed border-current/15 text-[11px] text-current/40"
      style={{ height: `${h}px` }}
    >
      {h >= 24 && `Spacer · ${h}px`}
    </div>
  );
}

// A quote / callout on the canvas: rich text in a shaded box with an optional
// attribution line, both edited in place. The fill and corner style are set in the
// section panel. Mirrors serializeQuote: a flat box with the same 16px inset, rounded
// (by the campaign's section radius) only when the quote opts in, and the
// attribution set as an italic "— name" line.
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
  const rounded = section.rounded === true;
  return (
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
      <div className="mt-1 flex items-center gap-1 text-sm italic">
        <span aria-hidden>—</span>
        <input
          value={section.attribution ?? ""}
          onChange={(e) => onUpdate({ attribution: e.target.value })}
          placeholder="Attribution (optional)"
          aria-label="Quote attribution"
          className="h-7 min-w-0 flex-1 bg-transparent outline-none placeholder:text-current placeholder:opacity-40"
        />
      </div>
    </div>
  );
}

// A social row on the canvas, drawn the way serializeSocial sends it: the lead-in,
// then each configured profile as a text link, dot-separated and aligned. The links
// themselves are managed in the section panel; with none yet, the row says so and
// clicking it opens the panel.
function SocialPreview({
  section,
  onEdit,
}: {
  section: CampaignSection;
  onEdit: () => void;
}) {
  const items = (section.socials ?? []).filter((s) => s.url.trim());
  const align = section.align ?? "center";
  const intro = section.socialIntro?.trim();
  if (items.length === 0) {
    return (
      <button
        type="button"
        onClick={onEdit}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-current/20 py-4 text-sm text-current/50 transition-colors hover:text-current/80"
      >
        <Share2 className="size-4" />
        Add your social links
      </button>
    );
  }
  return (
    <p
      className="py-1 text-[0.95rem]"
      style={{ textAlign: align }}
    >
      {intro ? `${intro} ` : ""}
      {items.map((s, i) => (
        <span key={i}>
          {i > 0 && " · "}
          <span className="underline" style={{ color: "var(--d3-link, inherit)" }}>
            {SOCIAL_LABELS[s.network]}
          </span>
        </span>
      ))}
    </p>
  );
}

// A card on the canvas (one image + rich text) arranged to mirror its layout, which
// is chosen in the section panel.
function CardEditor({
  section,
  onContentChange,
  onImageChange,
  onUploadImage,
  onRewrite,
}: {
  section: CampaignSection;
  onContentChange: (col: number, html: string) => void;
  onImageChange: (col: number, image: SectionImage | null) => void;
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
  selected,
  onSelect,
  onEditField,
  onContentChange,
  onImageChange,
  onButtonChange,
  onUpdate,
  onResize,
  onInsertBelow,
  onDuplicate,
  onRemove,
}: {
  section: CampaignSection;
  isOnly: boolean;
  canDuplicate: boolean;
  placeholder?: string;
  onRewrite?: (text: string, instruction: string) => Promise<string>;
  onUploadImage: (file: File) => Promise<string>;
  /** This section is the one the section panel is editing. */
  selected: boolean;
  onSelect: () => void;
  /** Select this section and open the panel focused on one of its fields. */
  onEditField: (field: string) => void;
  onContentChange: (columnIndex: number, html: string) => void;
  onImageChange: (columnIndex: number, image: SectionImage | null) => void;
  onButtonChange: (columnIndex: number, button: SectionButton) => void;
  onUpdate: (patch: Partial<CampaignSection>) => void;
  onResize: (height: number) => Promise<void>;
  onInsertBelow: (kind: SectionKind) => void;
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
      data-section=""
      // Any press or focus inside a section selects it, so writing in a section and
      // editing its settings are never two separate modes: the panel always shows
      // whatever you are working on. Capture phase, so it runs before the editor,
      // input or button inside takes the event (and even when one stops it).
      onPointerDownCapture={onSelect}
      onFocusCapture={onSelect}
      className={cn(
        "group/section relative rounded-xl bg-transparent",
        // While dragging, this node stays put as a dimmed placeholder reserving its
        // slot; the moving visual is the fixed-size clone in the DragOverlay, so the
        // section can't distort or smear over its neighbors as it travels.
        isDragging && "opacity-40",
      )}
    >
      {/* Selection outline. A fixed blue rather than the theme or app accent: it
          sits on the customer's own email colors, light or dark, and has to read on
          all of them. Hovering any other section shows a faint dashed version, so
          the canvas says "these are clickable blocks" before anyone clicks. The tab
          names the block, so the panel's subject is never in doubt. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -inset-x-2 inset-y-0 z-10 rounded-lg transition-[box-shadow,opacity]",
          selected
            ? "shadow-[0_0_0_2px_#3b82f6]"
            : "opacity-0 shadow-[0_0_0_1px_rgba(59,130,246,0.55)] group-hover/section:opacity-100",
        )}
      >
        {selected && (
          // The tag is also the way to the panel when it is closed (always, on a
          // phone, where an open panel would cover the email).
          <button
            type="button"
            onClick={() => onEditField("")}
            title="Section settings"
            className="pointer-events-auto absolute -top-2.5 left-2 flex items-center gap-1 rounded bg-[#3b82f6] px-1.5 py-px text-[10px] font-semibold leading-4 text-white transition-colors hover:bg-[#2563eb]"
          >
            {KIND_LABELS[section.kind]}
            <SlidersHorizontal className="size-2.5" />
          </button>
        )}
      </div>
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

      {/* Section actions, pushed out past the content card's edge so they sit on the
          page background (mirrors the drag handle's offset). Vertically centered as a
          group: add below, then duplicate, then remove. "Add below" exists because
          the button under the last section can only append: in a long email the new
          section otherwise lands at the bottom and has to be dragged all the way up.
          Revealed on hover/focus with a mouse: three stacked controls are taller than
          a one-line section, so neighbouring groups would otherwise overlap. A touch
          screen has no hover, so there they stay visible as before. */}
      <div
        className={cn(
          "absolute left-full top-1/2 z-10 ml-1 flex -translate-y-1/2 flex-col gap-0.5 opacity-0 transition-opacity group-hover/section:opacity-100 group-focus-within/section:opacity-100 has-[[data-popup-open]]:opacity-100 sm:ml-11 [@media(pointer:coarse)]:opacity-100",
          selected && "opacity-100",
        )}
      >
        <SectionKindPopover
          onAdd={onInsertBelow}
          side="right"
          align="center"
          trigger={
            <button
              type="button"
              aria-label="Add section below"
              disabled={!canDuplicate}
              title={
                canDuplicate
                  ? "Add section below"
                  : `A campaign can have at most ${MAX_SECTIONS} sections`
              }
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            />
          }
        >
          <Plus className="size-4" />
        </SectionKindPopover>
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
                  onEditLink={() => onEditField(`button-${col}-href`)}
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
            <DividerPreview line={section.line} height={section.height} />
          )}
          {section.kind === "quote" && (
            <QuoteEditor
              section={section}
              onContentChange={onContentChange}
              onUpdate={onUpdate}
              onRewrite={onRewrite}
            />
          )}
          {section.kind === "social" && (
            <SocialPreview section={section} onEdit={() => onEditField("social")} />
          )}
          {section.kind === "card" && (
            <CardEditor
              section={section}
              onContentChange={onContentChange}
              onImageChange={onImageChange}
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
  return (
    <SectionKindPopover
      onAdd={onAdd}
      side="top"
      align="center"
      trigger={
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
    </SectionKindPopover>
  );
}

// The grid of section kinds behind every "add a section" control: the full-width
// button under the last section, and the per-section "add below" in the gutter.
function SectionKindPopover({
  onAdd,
  trigger,
  side,
  align,
  children,
}: {
  onAdd: (kind: SectionKind) => void;
  trigger: ReactElement;
  side: "top" | "left" | "right" | "bottom";
  align: "start" | "center" | "end";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger}>{children}</PopoverTrigger>
      <PopoverContent side={side} align={align} className="w-auto p-2">
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

// Every structural edit to the section list, shared by the canvas (SectionEditor)
// and the section panel (SectionInspector) so the two can never disagree about what
// "remove" or "move" means. Commits read `latest` rather than the render-time list:
// uploading and cover-cropping an image are network round trips measured in seconds,
// and a commit built from a stale snapshot would quietly throw away everything typed
// while it was in flight.
export function useSectionList(
  value: CampaignSection[],
  onChange: (sections: CampaignSection[]) => void,
) {
  // Never let the builder go empty: there's always at least one section to edit.
  // Memoized so the fallback isn't a freshly minted id (and a remount) every render.
  const fallback = useMemo(() => [emptySection()], []);
  const sections = value.length > 0 ? value : fallback;
  // Synced in an effect (not during render) so it is a real post-commit mirror.
  const latest = useRef(sections);
  useEffect(() => {
    latest.current = sections;
  });

  function commit(next: CampaignSection[]) {
    onChange(next.length > 0 ? next : [emptySection()]);
  }

  function patch(id: string, updater: (s: CampaignSection) => CampaignSection) {
    const current = latest.current;
    // The section may have been removed while an async edit was in flight; then
    // there is nothing to patch and re-adding it would be the surprise.
    if (!current.some((s) => s.id === id)) return;
    commit(current.map((s) => (s.id === id ? updater(s) : s)));
  }

  // Inserts `section` right after `afterId` (or at the end) and returns its id.
  function insertAfter(afterId: string, section: CampaignSection): string {
    const current = latest.current;
    const at = current.findIndex((s) => s.id === afterId);
    const next = [...current];
    next.splice(at < 0 ? current.length : at + 1, 0, section);
    commit(next);
    return section.id;
  }

  function move(id: string, delta: -1 | 1) {
    const current = latest.current;
    const from = current.findIndex((s) => s.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= current.length) return;
    commit(arrayMove(current, from, to));
  }

  // Undo rather than a confirm dialog: a section is one click from gone and carries
  // writing that nothing else can recover (the editors' own undo stacks go with it).
  // A confirm would tax the common case, clearing an empty placeholder, for a mistake
  // that is cheap to reverse if we simply keep the section around.
  function remove(id: string) {
    const current = latest.current;
    const at = current.findIndex((s) => s.id === id);
    if (at < 0) return;
    const removed = current[at];
    commit(current.filter((s) => s.id !== id));
    toast("Section removed", {
      action: {
        label: "Undo",
        onClick: () => {
          const now = latest.current;
          if (now.some((s) => s.id === removed.id)) return;
          const next = [...now];
          next.splice(Math.min(at, next.length), 0, removed);
          commit(next);
        },
      },
    });
  }

  return { sections, latest, commit, patch, insertAfter, move, remove };
}

export function SectionEditor({
  value,
  onChange,
  onRewrite,
  onUploadImage,
  placeholder,
  className,
  selectedId,
  onSelect,
  onEditField,
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

  const { sections, latest, commit, patch: patchSection, insertAfter, remove } =
    useSectionList(value, onChange);
  const activeSection = activeId ? sections.find((s) => s.id === activeId) ?? null : null;
  // dnd-kit numbers its aria ids from a module counter, which differs between the
  // server render and hydration now that the campaign page renders on the server.
  const dndId = useId();

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
          id={dndId}
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
              selected={section.id === selectedId}
              onSelect={() => {
                if (section.id !== selectedId) onSelect(section.id);
              }}
              onEditField={(field) => onEditField(section.id, field)}
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
              onInsertBelow={(kind) =>
                onSelect(insertAfter(section.id, setSectionKind(emptySection(), kind)))
              }
              onDuplicate={() => onSelect(insertAfter(section.id, duplicateSection(section)))}
              onRemove={() => {
                // Removing the selected block hands the selection to a neighbor, so
                // the panel keeps a subject.
                if (section.id === selectedId) {
                  onSelect((sections[i + 1] ?? sections[i - 1])?.id ?? null);
                }
                remove(section.id);
              }}
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
        onAdd={(kind) => {
          const added = setSectionKind(emptySection(), kind);
          commit([...latest.current, added]);
          onSelect(added.id);
        }}
        disabled={sections.length >= MAX_SECTIONS}
      />
      </div>
    </RichTextEditorGroup>
  );
}
