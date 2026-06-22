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

  function formUrl(id) {
    return origin + "/f/" + encodeURIComponent(id) + "?embed=1";
  }

  function makeIframe(id) {
    var f = document.createElement("iframe");
    f.src = formUrl(id);
    f.setAttribute("data-day3-frame", id);
    f.title = "Newsletter signup";
    f.loading = "lazy";
    f.style.cssText =
      "border:0;width:100%;max-width:440px;height:520px;overflow:hidden;background:transparent";
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

  var openOverlay = null;

  function closePopup() {
    if (openOverlay) {
      openOverlay.remove();
      openOverlay = null;
    }
  }

  function openPopup(id) {
    if (openOverlay) return;
    var overlay = document.createElement("div");
    overlay.setAttribute("data-day3-overlay", "1");
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;z-index:2147483647;padding:16px;animation:day3fade .15s ease-out";

    var wrap = document.createElement("div");
    wrap.style.cssText = "position:relative;width:100%;max-width:460px";

    var close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = "&times;";
    close.style.cssText =
      "position:absolute;top:-12px;right:-12px;width:32px;height:32px;border-radius:50%;border:0;background:#fff;color:#111827;font-size:20px;line-height:1;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.25);z-index:1";
    close.addEventListener("click", closePopup);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closePopup();
    });

    wrap.appendChild(makeIframe(id));
    wrap.appendChild(close);
    overlay.appendChild(wrap);
    document.body.appendChild(overlay);
    openOverlay = overlay;
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closePopup();
  });

  function armTrigger(id, trigger) {
    if (trigger.indexOf("delay:") === 0) {
      var ms = parseInt(trigger.slice(6), 10) || 5000;
      setTimeout(function () {
        openPopup(id);
      }, ms);
    } else if (trigger === "exit-intent") {
      document.addEventListener("mouseout", function onOut(e) {
        if (e.clientY <= 0) {
          openPopup(id);
          document.removeEventListener("mouseout", onOut);
        }
      });
    } else if (trigger.indexOf("scroll:") === 0) {
      var pct = parseInt(trigger.slice(7), 10) || 50;
      window.addEventListener("scroll", function onScroll() {
        var max = document.body.scrollHeight - window.innerHeight;
        var seen = max > 0 ? (window.scrollY / max) * 100 : 100;
        if (seen >= pct) {
          openPopup(id);
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
    style.textContent = "@keyframes day3fade{from{opacity:0}to{opacity:1}}";
    document.head.appendChild(style);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan);
  } else {
    scan();
  }
})();
