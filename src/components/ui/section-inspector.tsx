"use client";

// The section panel: every setting of the selected section, in one place.
//
// The canvas is for content (writing, the button label, uploading an image, dragging
// a section or an image's height) and this panel is for everything else: what kind
// of block it is, its columns and alignment, its background, the kind's own options
// (a button's link and colors, an image's alt text, a quote's fill, a spacer's
// height, the social links) and the block's place in the email (move, duplicate,
// remove). Before this, those settings were scattered over hover toolbars above,
// beside and on top of each block, and a touch screen, having no hover, barely
// reached them.
//
// Controlled the same way as the canvas: the composer owns `sections` and the
// selection, and every structural edit goes through useSectionList, so the canvas
// and the panel share one definition of "remove" or "move".
import { useEffect, useRef, type ReactNode } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  Copy,
  MousePointerClick,
  PanelLeft,
  PanelRight,
  PanelTop,
  Plus,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SliderField } from "@/components/ui/color-field";
import { PanelGroup } from "@/components/ui/styling-panel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  COLUMN_KINDS,
  KIND_CHOICES,
  KIND_LABELS,
  useSectionList,
} from "@/components/ui/section-editor";
import {
  DEFAULT_BUTTON_BG,
  DEFAULT_BUTTON_TEXT,
  DEFAULT_QUOTE_BG,
  DEFAULT_SPACER_HEIGHT,
  MAX_SECTIONS,
  MAX_SPACER_HEIGHT,
  MIN_SPACER_HEIGHT,
  SOCIAL_LABELS,
  duplicateSection,
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

// Kinds whose content aligns left/center/right as a whole. Text aligns its prose; a
// button row positions its button(s); a social row positions its links. (An image
// fills its column; a card and a quote lay out their own content.)
const ALIGNABLE_KINDS = new Set<SectionKind>(["text", "button", "social"]);

// The default horizontal alignment per kind when a section has none set: a button
// row and a social row center; text reads left.
function defaultAlign(kind: SectionKind): SectionAlign {
  return kind === "text" ? "left" : "center";
}

// Fill palette for buttons: the brand color first, then a spread of accents and
// neutrals. The brand trio leads (espresso default, then caramel and clay), and the
// wider spread stays: these swatches dress the *sender's* email, not day3's UI, and
// their brand is not ours. Narrowing this to warm neutrals would be us choosing for
// them.
const FILL_SWATCHES = [
  DEFAULT_BUTTON_BG, "#b98145", "#a35f45", "#7c3aed", "#db2777",
  "#dc2626", "#ea580c", "#16a34a", "#0891b2", "#6b7280", "#ffffff",
];
// A button's label is a simpler light/dark choice: a colored fill almost always
// wants white or near-black text.
const LABEL_SWATCHES = [DEFAULT_BUTTON_TEXT, "#111827"];
// Soft tints for a callout's background, plus "no fill".
const QUOTE_SWATCHES = [
  DEFAULT_QUOTE_BG, "#f5ede0", "#eff6ff", "#f0fdf4", "#fef2f2", "#fefce8", "#faf5ff", "transparent",
];
// Section backgrounds: "no fill" first (the default, the section sits on the content
// background), then soft neutrals/tints and one dark for contrast blocks.
const SECTION_BG_SWATCHES = [
  "transparent", "#f9fafb", "#f4f4f5", "#eff6ff", "#f0fdf4",
  "#fef2f2", "#fefce8", "#faf5ff", "#111827",
];

const SOCIAL_NETWORKS = Object.keys(SOCIAL_LABELS) as SocialNetwork[];

const ALIGN_CHOICES: { value: SectionAlign; Icon: LucideIcon; label: string }[] = [
  { value: "left", Icon: AlignLeft, label: "Left" },
  { value: "center", Icon: AlignCenter, label: "Center" },
  { value: "right", Icon: AlignRight, label: "Right" },
];

const CARD_LAYOUTS: { value: CardLayout; Icon: LucideIcon; label: string }[] = [
  { value: "image-left", Icon: PanelLeft, label: "Image left" },
  { value: "image-right", Icon: PanelRight, label: "Image right" },
  { value: "image-top", Icon: PanelTop, label: "Image on top" },
];

// --- Small controls ----------------------------------------------------------

// A labeled row: the label on the left, the control on the right.
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

// A labeled stacked field: the label above a full-width control.
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground/70">{hint}</span>}
    </label>
  );
}

// A segmented control of text and/or icon options.
function Segmented<T extends string | number>({
  value,
  onChange,
  choices,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  choices: { value: T; label: string; Icon?: LucideIcon }[];
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
      {choices.map(({ value: v, label: l, Icon }) => (
        <button
          key={String(v)}
          type="button"
          aria-pressed={value === v}
          aria-label={Icon ? l : undefined}
          title={Icon ? l : undefined}
          onClick={() => onChange(v)}
          className={cn(
            "flex h-7 items-center justify-center rounded text-xs font-medium transition-colors",
            Icon ? "w-8" : "px-2.5",
            value === v
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {Icon ? <Icon className="size-3.5" /> : l}
        </button>
      ))}
    </div>
  );
}

// A row of color swatches. The active swatch gets a ring; "transparent" renders as a
// checkered chip. Only ever emits one of the swatch values themselves, so every color
// that reaches the serializer is one it already accepts.
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
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      {swatches.map((c) => {
        const active = (value ?? swatches[0]) === c;
        const transparent = c === "transparent";
        return (
          <button
            key={c}
            type="button"
            aria-label={transparent ? "No fill" : c}
            aria-pressed={active}
            title={transparent ? "No fill" : c}
            onClick={() => onChange(c)}
            style={transparent ? undefined : { backgroundColor: c }}
            className={cn(
              "size-6 rounded-full border border-foreground/30 transition-transform hover:scale-110",
              transparent &&
                "bg-[linear-gradient(45deg,#ccc_25%,transparent_25%,transparent_75%,#ccc_75%),linear-gradient(45deg,#ccc_25%,transparent_25%,transparent_75%,#ccc_75%)] bg-[length:8px_8px] bg-[position:0_0,4px_4px]",
              active && "ring-2 ring-foreground/50 ring-offset-2 ring-offset-card",
            )}
          />
        );
      })}
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
  destructive,
  Icon,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  Icon: LucideIcon;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-30",
        destructive ? "hover:text-destructive" : "hover:text-foreground",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

// --- Kind-specific settings --------------------------------------------------

function ButtonSettings({
  section,
  onButtonChange,
}: {
  section: CampaignSection;
  onButtonChange: (col: number, button: SectionButton) => void;
}) {
  return (
    <>
      {Array.from({ length: section.columns }, (_, col) => {
        const button: SectionButton = section.buttons?.[col] ?? { label: "", href: "" };
        const update = (patch: Partial<SectionButton>) =>
          onButtonChange(col, { ...button, ...patch });
        return (
          <PanelGroup key={col} title={section.columns > 1 ? `Button ${col + 1}` : "Button"}>
            <Field label="Label">
              <Input
                value={button.label}
                onChange={(e) => update({ label: e.target.value })}
                placeholder="Button"
                className="h-8"
              />
            </Field>
            <Field label="Link" hint={button.href.trim() ? undefined : "Needed for the button to appear in the email."}>
              <Input
                data-inspector-field={`button-${col}-href`}
                value={button.href}
                onChange={(e) => update({ href: e.target.value })}
                placeholder="https://…"
                className="h-8"
              />
            </Field>
            <div className="space-y-1.5">
              <span className="text-sm text-muted-foreground">Fill</span>
              <ColorSwatches
                value={button.bgColor ?? DEFAULT_BUTTON_BG}
                onChange={(c) => update({ bgColor: c })}
                swatches={FILL_SWATCHES}
                label="Button fill color"
              />
            </div>
            <Row label="Label color">
              <ColorSwatches
                value={button.textColor ?? DEFAULT_BUTTON_TEXT}
                onChange={(c) => update({ textColor: c })}
                swatches={LABEL_SWATCHES}
                label="Label color"
              />
            </Row>
            <Row label="Full width">
              <Switch
                checked={!!button.fullWidth}
                onCheckedChange={(checked) => update({ fullWidth: checked })}
                aria-label="Full-width button"
              />
            </Row>
          </PanelGroup>
        );
      })}
    </>
  );
}

// Alt text and click-through link for each uploaded image in the section.
function ImageSettings({
  section,
  columns,
  onImageChange,
}: {
  section: CampaignSection;
  columns: number;
  onImageChange: (col: number, image: SectionImage | null) => void;
}) {
  const images = Array.from({ length: columns }, (_, col) => section.images?.[col] ?? null);
  if (!images.some((img) => img?.src)) {
    return (
      <PanelGroup title="Image">
        <p className="text-sm text-muted-foreground">
          Upload an image on the canvas, then set its alt text and link here.
        </p>
      </PanelGroup>
    );
  }
  return (
    <>
      {images.map((img, col) =>
        img?.src ? (
          <PanelGroup key={col} title={columns > 1 ? `Image ${col + 1}` : "Image"}>
            <Field label="Alt text" hint="Shown if the image can't load, and read aloud by screen readers.">
              <Input
                value={img.alt ?? ""}
                onChange={(e) => onImageChange(col, { ...img, alt: e.target.value })}
                placeholder="Describe this image"
                className="h-8"
              />
            </Field>
            <Field label="Link" hint="Optional. Makes the image clickable.">
              <Input
                value={img.href ?? ""}
                onChange={(e) => onImageChange(col, { ...img, href: e.target.value || undefined })}
                placeholder="https://…"
                className="h-8"
              />
            </Field>
          </PanelGroup>
        ) : null,
      )}
      {section.kind === "image" && (
        <p className="text-xs text-muted-foreground/70">
          Drag the handle under the image to change its height.
        </p>
      )}
    </>
  );
}

function SocialSettings({
  section,
  onUpdate,
}: {
  section: CampaignSection;
  onUpdate: (patch: Partial<CampaignSection>) => void;
}) {
  const socials = section.socials ?? [];
  const networkItems = Object.fromEntries(SOCIAL_NETWORKS.map((n) => [n, SOCIAL_LABELS[n]]));
  const setItem = (i: number, patch: Partial<SocialItem>) =>
    onUpdate({ socials: socials.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const add = () => {
    const used = new Set(socials.map((s) => s.network));
    const next = SOCIAL_NETWORKS.find((n) => !used.has(n)) ?? "website";
    onUpdate({ socials: [...socials, { network: next, url: "" }] });
  };
  return (
    <PanelGroup title="Social links">
      <Field label="Lead-in">
        <Input
          value={section.socialIntro ?? ""}
          onChange={(e) => onUpdate({ socialIntro: e.target.value })}
          placeholder="e.g. Follow us:"
          className="h-8"
        />
      </Field>
      <div className="space-y-1.5" data-inspector-field="social" tabIndex={-1}>
        {socials.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Select
              items={networkItems}
              value={s.network}
              onValueChange={(v) => v && setItem(i, { network: v as SocialNetwork })}
            >
              <SelectTrigger aria-label="Network" className="h-8 w-28 shrink-0">
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
              placeholder={s.network === "email" ? "hi@…" : "https://…"}
              aria-label={`${SOCIAL_LABELS[s.network]} URL`}
              className="h-8 min-w-0"
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
        <button
          type="button"
          onClick={add}
          disabled={socials.length >= 12}
          className="flex h-8 items-center gap-1.5 rounded-md px-1 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          <Plus className="size-4" />
          Add link
        </button>
      </div>
    </PanelGroup>
  );
}

// --- The panel ---------------------------------------------------------------

export function SectionInspector({
  sections: value,
  onChange,
  selectedId,
  onSelect,
  focusField,
  onFieldFocused,
}: {
  sections: CampaignSection[];
  onChange: (sections: CampaignSection[]) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** A field to focus once it renders (a canvas hint asked for it), e.g. a button's link. */
  focusField: string | null;
  onFieldFocused: () => void;
}) {
  const { sections, patch, insertAfter, move, remove } = useSectionList(value, onChange);
  const index = sections.findIndex((s) => s.id === selectedId);
  const section = index >= 0 ? sections[index] : null;
  const rootRef = useRef<HTMLDivElement>(null);

  // Land on the field a canvas hint pointed at ("Add a link so this button
  // appears…"). After render, since the panel may only just have opened.
  useEffect(() => {
    if (!focusField || !section) return;
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-inspector-field="${focusField}"]`,
    );
    if (el) {
      el.scrollIntoView({ block: "nearest" });
      el.focus({ preventScroll: true });
    }
    onFieldFocused();
  }, [focusField, section, onFieldFocused]);

  if (!section) {
    return (
      <div className="flex flex-col items-center gap-2 px-2 py-8 text-center">
        <MousePointerClick className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">Select a section</p>
        <p className="text-xs text-muted-foreground">
          Click any block in the email to change its type, layout, colors and links here.
        </p>
      </div>
    );
  }

  const id = section.id;
  const update = (p: Partial<CampaignSection>) => patch(id, (s) => ({ ...s, ...p }));
  const onImageChange = (col: number, image: SectionImage | null) =>
    patch(id, (s) => {
      const images = Array.from({ length: Math.max(s.columns, 1) }, (_, i) => s.images?.[i] ?? null);
      images[col] = image;
      return { ...s, images };
    });
  const onButtonChange = (col: number, button: SectionButton) =>
    patch(id, (s) => {
      const buttons = Array.from({ length: s.columns }, (_, i) => s.buttons?.[i] ?? null);
      buttons[col] = button;
      return { ...s, buttons };
    });
  const canAdd = sections.length < MAX_SECTIONS;
  const KindIcon = KIND_CHOICES.find((k) => k.value === section.kind)?.Icon;

  return (
    <div ref={rootRef} className="space-y-5">
      {/* Which block this is, where it sits, and the block-level actions. */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {KindIcon && <KindIcon className="size-4 shrink-0 text-muted-foreground" />}
          <span className="truncate text-sm font-semibold">{KIND_LABELS[section.kind]}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {index + 1} of {sections.length}
          </span>
        </div>
        <div className="flex shrink-0 items-center">
          <ActionButton label="Move up" Icon={ArrowUp} onClick={() => move(id, -1)} disabled={index === 0} />
          <ActionButton
            label="Move down"
            Icon={ArrowDown}
            onClick={() => move(id, 1)}
            disabled={index === sections.length - 1}
          />
          <ActionButton
            label="Duplicate"
            Icon={Copy}
            onClick={() => onSelect(insertAfter(id, duplicateSection(section)))}
            disabled={!canAdd}
          />
          <ActionButton
            label="Remove"
            Icon={Trash2}
            destructive
            disabled={sections.length === 1}
            onClick={() => {
              // Hand the selection to a neighbor, so the panel keeps a subject and a
              // run of deletions can be done without going back to the canvas.
              const neighbor = sections[index + 1] ?? sections[index - 1] ?? null;
              remove(id);
              onSelect(neighbor?.id ?? null);
            }}
          />
        </div>
      </div>

      <PanelGroup title="Type">
        {/* Switching keeps content, uploads and buttons across the change (see
            setSectionKind), so trying another kind never loses work. */}
        <div className="grid grid-cols-4 gap-1">
          {KIND_CHOICES.map(({ value: kind, label, Icon }) => (
            <button
              key={kind}
              type="button"
              aria-pressed={section.kind === kind}
              onClick={() => patch(id, (s) => setSectionKind(s, kind))}
              className={cn(
                "flex h-14 flex-col items-center justify-center gap-1 rounded-md px-0.5 text-center text-[11px] leading-tight transition-colors",
                section.kind === kind
                  ? "bg-muted text-foreground ring-1 ring-border"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {label}
            </button>
          ))}
        </div>
      </PanelGroup>

      {(COLUMN_KINDS.has(section.kind) ||
        ALIGNABLE_KINDS.has(section.kind) ||
        section.kind === "card" ||
        section.kind === "divider" ||
        section.kind === "quote") && (
        <PanelGroup title="Layout">
          {COLUMN_KINDS.has(section.kind) && (
            <Row label="Columns">
              <Segmented<ColumnCount>
                value={section.columns}
                onChange={(n) => patch(id, (s) => resizeSection(s, n))}
                choices={[
                  { value: 1, label: "1" },
                  { value: 2, label: "2" },
                  { value: 3, label: "3" },
                ]}
                label="Columns"
              />
            </Row>
          )}
          {ALIGNABLE_KINDS.has(section.kind) && (
            <Row label="Align">
              <Segmented
                value={section.align ?? defaultAlign(section.kind)}
                onChange={(a) => update({ align: a })}
                choices={ALIGN_CHOICES}
                label="Alignment"
              />
            </Row>
          )}
          {section.kind === "card" && (
            <Row label="Image">
              <Segmented
                value={section.layout ?? "image-left"}
                onChange={(l) => update({ layout: l })}
                choices={CARD_LAYOUTS}
                label="Card layout"
              />
            </Row>
          )}
          {section.kind === "divider" && (
            <>
              <Row label="Style">
                <Segmented
                  value={section.line === false ? "spacer" : "line"}
                  onChange={(v) => update({ line: v === "line" })}
                  choices={[
                    { value: "line", label: "Line" },
                    { value: "spacer", label: "Spacer" },
                  ]}
                  label="Divider style"
                />
              </Row>
              {section.line === false && (
                <SliderField
                  label="Height"
                  value={Math.round(
                    Math.max(
                      MIN_SPACER_HEIGHT,
                      Math.min(MAX_SPACER_HEIGHT, section.height ?? DEFAULT_SPACER_HEIGHT),
                    ),
                  )}
                  onChange={(h) => update({ height: h })}
                  min={MIN_SPACER_HEIGHT}
                  max={MAX_SPACER_HEIGHT}
                />
              )}
            </>
          )}
          {section.kind === "quote" && (
            <Row label="Corners">
              <Segmented
                value={section.rounded === true ? "rounded" : "square"}
                onChange={(v) => update({ rounded: v === "rounded" })}
                choices={[
                  { value: "square", label: "Square" },
                  { value: "rounded", label: "Rounded" },
                ]}
                label="Callout corners"
              />
            </Row>
          )}
        </PanelGroup>
      )}

      {section.kind === "button" && <ButtonSettings section={section} onButtonChange={onButtonChange} />}
      {section.kind === "image" && (
        <ImageSettings section={section} columns={section.columns} onImageChange={onImageChange} />
      )}
      {section.kind === "card" && (
        <ImageSettings section={section} columns={1} onImageChange={onImageChange} />
      )}
      {section.kind === "social" && <SocialSettings section={section} onUpdate={update} />}
      {section.kind === "quote" && (
        <PanelGroup title="Callout">
          <div className="space-y-1.5">
            <span className="text-sm text-muted-foreground">Fill</span>
            <ColorSwatches
              value={section.bgColor ?? DEFAULT_QUOTE_BG}
              onChange={(c) => update({ bgColor: c })}
              swatches={QUOTE_SWATCHES}
              label="Callout color"
            />
          </div>
        </PanelGroup>
      )}
      {section.kind === "text" && (
        <p className="text-xs text-muted-foreground/80">
          Select text on the canvas to format it or add a link. Type{" "}
          <code className="rounded bg-muted px-1">{"{{"}</code> to personalize.
        </p>
      )}

      <PanelGroup title="Background">
        <ColorSwatches
          value={section.sectionBg ?? "transparent"}
          onChange={(c) => update({ sectionBg: c === "transparent" ? undefined : c })}
          swatches={SECTION_BG_SWATCHES}
          label="Section background"
        />
        <p className="text-xs text-muted-foreground/70">Fills the full width of the email.</p>
      </PanelGroup>
    </div>
  );
}
