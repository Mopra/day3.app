// The root layout forces the app's dark theme (<html class="dark">), which paints a
// near-black <body> behind every page. The public form document must not inherit
// that: hosted, it renders on the form's own light page background; iframed
// (?embed=1) the document has to be truly transparent so the *host site* shows
// through around the card instead of our dark body. A nested layout can't change
// <html> attributes, so we override at the document level from here.
//
// color-scheme:light matters twice over — it keeps native form controls light, and
// browsers only keep a cross-origin iframe transparent when its color-scheme
// matches the embedding page (host sites are overwhelmingly light).
export default function PublicFormLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <style>{`html,body{background:transparent !important}html{color-scheme:light}`}</style>
      {children}
    </>
  );
}
