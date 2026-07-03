/*!
 * Day3 signup-form widget. Drop-in convenience over the hosted form:
 *
 *   Inline:  <div data-day3-form="frm_..."></div>
 *            <script src="https://go.day3.app/embed.js" async></script>
 *
 *   Popup:   <button data-day3-form="frm_..." data-day3-mode="popup">Subscribe</button>
 *            <script src="https://go.day3.app/embed.js" async></script>
 *
 *   Auto popup triggers (on a non-clickable element):
 *     data-day3-trigger="delay:5000"  | "exit-intent" | "scroll:50"
 *
 * The widget only renders the hosted form in an iframe (same reliability as the
 * raw iframe embed) — it adds inline injection, modals, and triggers. It loads
 * the form from its own <script src> origin, so it works on any site.
 *
 * Auto triggers fire at most once per browser session (sessionStorage): a visitor
 * who closes the popup is not shown it again until their next visit. Clicking a
 * popup button always opens it — that's explicit intent.
 */
(function () {
  "use strict";
  var script = document.currentScript;
  var origin = "";
  try {
    origin = new URL(script.src).origin;
  } catch (e) {
    origin = "";
  }

  function reduceMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) {
      return false;
    }
  }

  function formUrl(id) {
    return origin + "/f/" + encodeURIComponent(id) + "?embed=1";
  }

  // 464 = the form card's 440px max-width plus its document's 12px padding per side,
  // so the card renders at full width instead of being squeezed by the frame.
  function makeIframe(id) {
    var f = document.createElement("iframe");
    f.src = formUrl(id);
    f.setAttribute("data-day3-frame", id);
    f.title = "Newsletter signup";
    f.loading = "lazy";
    f.style.cssText =
      "border:0;width:100%;max-width:464px;height:520px;overflow:hidden;background:transparent";
    return f;
  }

  // Resize each iframe to the height its hosted form reports. We match by
  // contentWindow === event.source so multiple forms on one page each track
  // their own height.
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.type !== "day3:resize") return;
    var frames = document.querySelectorAll("iframe[data-day3-frame]");
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === e.source) {
        frames[i].style.height = e.data.height + "px";
      }
    }
  });

  // Auto triggers remember they've fired so navigating between pages doesn't
  // re-open a popup the visitor already dismissed. Session-scoped on purpose:
  // a returning visitor tomorrow may convert where today's didn't.
  function seenKey(id) {
    return "day3:popup:" + id;
  }
  function wasSeen(id) {
    try {
      return sessionStorage.getItem(seenKey(id)) === "1";
    } catch (e) {
      return false;
    }
  }
  function markSeen(id) {
    try {
      sessionStorage.setItem(seenKey(id), "1");
    } catch (e) {}
  }

  var openOverlay = null;
  var lastFocused = null;
  var prevHtmlOverflow = "";

  function closePopup() {
    if (!openOverlay) return;
    var overlay = openOverlay;
    openOverlay = null;
    document.documentElement.style.overflow = prevHtmlOverflow;
    if (lastFocused && lastFocused.focus) {
      try {
        lastFocused.focus({ preventScroll: true });
      } catch (e) {}
    }
    lastFocused = null;
    if (reduceMotion()) {
      overlay.remove();
      return;
    }
    overlay.className = "day3-closing";
    setTimeout(function () {
      overlay.remove();
    }, 180);
  }

  function openPopup(id) {
    if (openOverlay) return;
    var overlay = document.createElement("div");
    overlay.setAttribute("data-day3-overlay", "1");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Newsletter signup");
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(17,17,20,.32);-webkit-backdrop-filter:saturate(140%) blur(14px);backdrop-filter:saturate(140%) blur(14px);display:flex;align-items:center;justify-content:center;z-index:2147483647;padding:20px";

    var wrap = document.createElement("div");
    wrap.className = "day3-wrap";
    wrap.style.cssText = "position:relative;width:100%;max-width:464px";

    var close = document.createElement("button");
    close.type = "button";
    close.className = "day3-close";
    close.setAttribute("aria-label", "Close");
    close.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    close.style.cssText =
      "position:absolute;top:-12px;right:-12px;width:32px;height:32px;border-radius:50%;border:1px solid rgba(0,0,0,.08);background:rgba(255,255,255,.95);color:#1d1d1f;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.12);z-index:1;display:flex;align-items:center;justify-content:center;padding:0";
    close.addEventListener("click", closePopup);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closePopup();
    });

    var frame = makeIframe(id);
    // Never taller than the viewport — the form document scrolls inside instead.
    frame.style.maxHeight = "85vh";
    frame.style.maxHeight = "calc(100dvh - 88px)";
    wrap.appendChild(frame);
    wrap.appendChild(close);
    overlay.appendChild(wrap);

    lastFocused = document.activeElement;
    prevHtmlOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.body.appendChild(overlay);
    try {
      close.focus({ preventScroll: true });
    } catch (e) {}
    openOverlay = overlay;
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closePopup();
  });

  function autoOpen(id) {
    if (wasSeen(id)) return;
    markSeen(id);
    openPopup(id);
  }

  function armTrigger(id, trigger) {
    if (wasSeen(id)) return;
    if (trigger.indexOf("delay:") === 0) {
      var ms = parseInt(trigger.slice(6), 10) || 5000;
      setTimeout(function () {
        autoOpen(id);
      }, ms);
    } else if (trigger === "exit-intent") {
      document.addEventListener("mouseout", function onOut(e) {
        if (e.clientY <= 0) {
          autoOpen(id);
          document.removeEventListener("mouseout", onOut);
        }
      });
    } else if (trigger.indexOf("scroll:") === 0) {
      var pct = parseInt(trigger.slice(7), 10) || 50;
      window.addEventListener("scroll", function onScroll() {
        var max = document.body.scrollHeight - window.innerHeight;
        var seen = max > 0 ? (window.scrollY / max) * 100 : 100;
        if (seen >= pct) {
          autoOpen(id);
          window.removeEventListener("scroll", onScroll);
        }
      });
    }
  }

  function initEl(el) {
    if (el.getAttribute("data-day3-init")) return;
    el.setAttribute("data-day3-init", "1");
    var id = el.getAttribute("data-day3-form");
    if (!id) return;

    var tag = el.tagName;
    var clickable = tag === "BUTTON" || tag === "A";
    var mode = el.getAttribute("data-day3-mode") || (clickable ? "popup" : "inline");

    if (mode === "inline") {
      el.appendChild(makeIframe(id));
      return;
    }

    // popup
    if (clickable) {
      el.addEventListener("click", function (e) {
        e.preventDefault();
        openPopup(id);
      });
    }
    var trigger = el.getAttribute("data-day3-trigger");
    if (trigger) armTrigger(id, trigger);
  }

  function scan() {
    var els = document.querySelectorAll("[data-day3-form]");
    for (var i = 0; i < els.length; i++) {
      if (els[i].tagName !== "IFRAME") initEl(els[i]);
    }
  }

  if (!document.getElementById("day3-embed-style")) {
    var style = document.createElement("style");
    style.id = "day3-embed-style";
    style.textContent =
      "@keyframes day3fade{from{opacity:0}to{opacity:1}}" +
      "@keyframes day3rise{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:none}}" +
      "[data-day3-overlay]{animation:day3fade .2s ease-out}" +
      "[data-day3-overlay].day3-closing{opacity:0;transition:opacity .16s ease-in;pointer-events:none}" +
      "[data-day3-overlay] .day3-wrap{animation:day3rise .32s cubic-bezier(.32,.72,0,1)}" +
      ".day3-close{transition:transform .16s ease,background-color .16s ease}" +
      ".day3-close:hover{background:#fff;transform:scale(1.06)}" +
      ".day3-close:active{transform:scale(.95)}" +
      "@media (prefers-reduced-motion:reduce){[data-day3-overlay],[data-day3-overlay] .day3-wrap{animation:none}.day3-close{transition:none}}";
    document.head.appendChild(style);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan);
  } else {
    scan();
  }
})();
