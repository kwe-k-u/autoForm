// ============================================================
// AutoForm Landing Page – Interactive Behaviors
// ============================================================

(function () {
  "use strict";

  // ----------------------------------------------------------
  // FAQ ACCORDION
  // ----------------------------------------------------------
  // Each FAQ card has a plus icon made of two lines:
  //   .framer-1j3c755  (vertical line, rotated 90deg)
  //   .framer-g672d7   (horizontal line)
  // Toggling the "open" class rotates the vertical line to
  // 0deg (forming a minus) and shows/hides the answer panel.
  // ----------------------------------------------------------

  function initAccordions() {
    // The accordion cards live inside .framer-yDdGC containers
    // with data-framer-name "Min" or "Min Mobile". Each has a
    // clickable .framer-na2768 (Card) element.
    var cards = document.querySelectorAll(
      '.framer-yDdGC[data-framer-name="Min"], ' +
        '.framer-yDdGC[data-framer-name="Min Mobile"]'
    );

    if (!cards.length) return;

    cards.forEach(function (card) {
      // Skip if already wired up
      if (card.dataset.accordionInit) return;
      card.dataset.accordionInit = "true";

      var clickable = card.querySelector('[data-framer-name="Card"]');
      if (!clickable) return;

      // The plus icon container
      var iconWrap = card.querySelector(
        '[data-framer-name="plus: Frame 1"]'
      );
      // The vertical line (rotated 90deg by default → plus shape)
      var verticalLine = iconWrap
        ? iconWrap.querySelector(".framer-1j3c755")
        : null;

      // Create an answer panel that will be toggled.  The original
      // Framer export did not include answer text, so we insert an
      // empty container that can be populated via the answers map
      // below or left empty as a placeholder.
      var answerPanel = document.createElement("div");
      answerPanel.className = "faq-answer-panel";
      answerPanel.setAttribute("role", "region");
      answerPanel.setAttribute("aria-hidden", "true");
      answerPanel.style.maxHeight = "0";
      answerPanel.style.overflow = "hidden";
      answerPanel.style.transition =
        "max-height 0.35s cubic-bezier(0.4,0,0.2,1), opacity 0.25s ease";
      answerPanel.style.opacity = "0";

      // Insert answer panel AFTER the Card div (sibling, not child)
      // so that .framer-na2768's overflow:hidden doesn't clip it.
      clickable.parentNode.insertBefore(answerPanel, clickable.nextSibling);

      // Populate answer text from the map if available
      var heading = clickable.querySelector("h2");
      var questionText = heading ? heading.textContent.trim() : "";
      var answerText = FAQ_ANSWERS[questionText] || "";
      if (answerText) {
        answerPanel.innerHTML =
          '<div style="padding:0 0 16px 0;font-size:14px;line-height:1.6;color:var(--token-32705945-0bd7-47fd-8f01-f9c74ba13b43,#768e84)">' +
          answerText +
          "</div>";
      }

      // Click handler
      clickable.addEventListener("click", function (e) {
        // Don't interfere with link clicks inside the card
        if (e.target.closest("a")) return;
        toggleAccordion(card, answerPanel, verticalLine);
      });

      // Keyboard accessibility
      clickable.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleAccordion(card, answerPanel, verticalLine);
        }
      });

      // Mark as interactive
      clickable.setAttribute("tabindex", "0");
      clickable.setAttribute("aria-expanded", "false");
    });
  }

  function toggleAccordion(card, panel, verticalLine) {
    var isOpen = card.classList.contains("faq-open");
    var cardParent = card.closest(".framer-yDdGC");

    if (isOpen) {
      // Close
      panel.style.maxHeight = "0";
      panel.style.opacity = "0";
      panel.setAttribute("aria-hidden", "true");
      card.classList.remove("faq-open");
      card.style.overflow = "";
      if (cardParent) cardParent.style.overflow = "";
      if (verticalLine) {
        verticalLine.style.transform = "rotate(90deg)";
        verticalLine.style.transition =
          "transform 0.3s cubic-bezier(0.4,0,0.2,1)";
      }
      var clickable = card.querySelector('[data-framer-name="Card"]');
      if (clickable) clickable.setAttribute("aria-expanded", "false");
    } else {
      // Close other open accordions first (single-open behaviour)
      var accordion = card.closest('[data-framer-name="Accordion"]');
      if (accordion) {
        var siblings = accordion.querySelectorAll(".faq-open");
        siblings.forEach(function (sibling) {
          if (sibling === card) return;
          var sibPanel = sibling.querySelector(".faq-answer-panel");
          var sibLine = sibling.querySelector(".framer-1j3c755");
          var sibParent = sibling.closest(".framer-yDdGC");
          if (sibPanel) {
            sibPanel.style.maxHeight = "0";
            sibPanel.style.opacity = "0";
            sibPanel.setAttribute("aria-hidden", "true");
          }
          sibling.classList.remove("faq-open");
          sibling.style.overflow = "";
          if (sibParent) sibParent.style.overflow = "";
          if (sibLine) {
            sibLine.style.transform = "rotate(90deg)";
            sibLine.style.transition =
              "transform 0.3s cubic-bezier(0.4,0,0.2,1)";
          }
          var sibClickable = sibling.querySelector(
            '[data-framer-name="Card"]'
          );
          if (sibClickable)
            sibClickable.setAttribute("aria-expanded", "false");
        });
      }

      // Open this one – release overflow so the answer panel is visible
      card.style.overflow = "visible";
      if (cardParent) cardParent.style.overflow = "visible";
      panel.style.maxHeight = panel.scrollHeight + "px";
      panel.style.opacity = "1";
      panel.setAttribute("aria-hidden", "false");
      card.classList.add("faq-open");
      if (verticalLine) {
        verticalLine.style.transform = "rotate(0deg)";
        verticalLine.style.transition =
          "transform 0.3s cubic-bezier(0.4,0,0.2,1)";
      }
      var clickable = card.querySelector('[data-framer-name="Card"]');
      if (clickable) clickable.setAttribute("aria-expanded", "true");
    }
  }

  // FAQ answer content – edit these strings to populate the
  // accordion panels.  Keys must match the question text exactly.
  var FAQ_ANSWERS = {
    "What types of applications can I use AutoForm for?":
      "AutoForm supports applications for schools, scholarships, startups, and jobs. Our AI-powered tools adapt to your specific needs across 50+ countries.",
    "Is AutoForm free to use?":
      "AutoForm offers early access pricing. Sign up for our waitlist to be notified when we launch and get exclusive early access benefits.",
    "How is AutoForm different from other application tools?":
      "AutoForm combines AI-powered templates, guided writing assistance, and success analytics into one seamless platform. We support applications across schools, scholarships, startups, and jobs.",
    "How does the AI guidance work?":
      "Our AI analyzes your application type and provides real-time feedback, suggestions, and tailored templates to help you craft compelling applications that maximize your chances of success.",
  };

  // ----------------------------------------------------------
  // MOBILE MENU TOGGLE
  // ----------------------------------------------------------
  // The hamburger icon (.framer-co8brr) toggles a mobile nav
  // overlay.  The icon itself is two bordered bars that animate
  // into an X when open.
  // ----------------------------------------------------------

  function initMobileMenu() {
    var menuBtn = document.querySelector(
      '.framer-co8brr[data-framer-name="MENU"]'
    );
    if (!menuBtn || menuBtn.dataset.menuInit) return;
    menuBtn.dataset.menuInit = "true";

    // The two bars inside the hamburger
    var bar1 = menuBtn.querySelector(".framer-ap2v45");
    var bar2 = menuBtn.querySelector(".framer-tw6clg");

    // Find the mobile nav panel – it sits as a sibling after the
    // mobile nav bar container.  We'll look for nav elements or
    // slide-down panels within the same parent.
    var mobileNavContainer = menuBtn.closest(".framer-1adko1i");

    var isOpen = false;

    function toggleMenu() {
      isOpen = !isOpen;

      if (bar1 && bar2) {
        if (isOpen) {
          // Rotate bars into X
          bar1.style.transition =
            "transform 0.3s cubic-bezier(0.4,0,0.2,1)";
          bar2.style.transition =
            "transform 0.3s cubic-bezier(0.4,0,0.2,1)";
          bar1.style.transform = "rotate(45deg) translate(3px, 3px)";
          bar2.style.transform = "rotate(-45deg) translate(3px, -3px)";
        } else {
          bar1.style.transition =
            "transform 0.3s cubic-bezier(0.4,0,0.2,1)";
          bar2.style.transition =
            "transform 0.3s cubic-bezier(0.4,0,0.2,1)";
          bar1.style.transform = "none";
          bar2.style.transform = "none";
        }
      }

      // Toggle the menu panel visibility.  The mobile nav
      // content typically lives in a container after the
      // hamburger row.  Find any nav or dropdown that should
      // appear.
      if (mobileNavContainer) {
        // Look for a nav or content area that isn't the top bar
        var allChildren = mobileNavContainer.children;
        for (var i = 0; i < allChildren.length; i++) {
          var child = allChildren[i];
          if (child.contains(menuBtn)) continue; // skip the top bar
          if (child.tagName === "NAV" || child.dataset?.framerName) {
            if (isOpen) {
              child.style.display = "";
              child.style.maxHeight = child.scrollHeight + "px";
              child.style.opacity = "1";
              child.style.overflow = "hidden";
              child.style.transition =
                "max-height 0.35s ease, opacity 0.25s ease";
            } else {
              child.style.maxHeight = "0";
              child.style.opacity = "0";
              setTimeout(function () {
                child.style.overflow = "hidden";
              }, 350);
            }
          }
        }
      }
    }

    menuBtn.addEventListener("click", toggleMenu);
    menuBtn.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleMenu();
      }
    });
  }

  // ----------------------------------------------------------
  // SMOOTH SCROLL FOR ANCHOR LINKS
  // ----------------------------------------------------------
  // Framer pages use hash-based navigation for in-page
  // sections.  This adds smooth-scrolling for those links.
  // ----------------------------------------------------------

  function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(function (link) {
      link.addEventListener("click", function (e) {
        var targetId = this.getAttribute("href");
        if (!targetId || targetId === "#") return;
        var target = document.querySelector(targetId);
        if (!target) return;
        e.preventDefault();
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        // Update URL hash without jump
        if (history.pushState) {
          history.pushState(null, null, targetId);
        }
      });
    });
  }

  // ----------------------------------------------------------
  // CTA BUTTON HOVER GLOW EFFECT
  // ----------------------------------------------------------
  // The CTA buttons (.framer-1p9unnn, .framer-9XPQy) have a
  // hidden glow circle (.framer-rqly2r / .framer-126kii2) that
  // scales up on hover.  Framer's client JS is disabled, so
  // we replicate this with plain JS + CSS.
  // ----------------------------------------------------------

  function initCTAHover() {
    var ctaLinks = document.querySelectorAll(
      ".framer-1p9unnn, .framer-9XPQy"
    );
    ctaLinks.forEach(function (cta) {
      if (cta.dataset.ctaInit) return;
      cta.dataset.ctaInit = "true";

      // Find the glow/ring element inside
      var glow = cta.querySelector(
        ".framer-rqly2r, .framer-126kii2"
      );
      if (!glow) return;

      // Ensure transition is set
      glow.style.transition =
        "transform 0.3s cubic-bezier(0.4,0,0.2,1), opacity 0.3s ease";

      cta.addEventListener("mouseenter", function () {
        glow.style.transform = "translateY(-50%) scale(1)";
        glow.style.opacity = "1";
      });

      cta.addEventListener("mouseleave", function () {
        glow.style.transform = "translateY(-50%) scale(0)";
        glow.style.opacity = "0";
      });
    });
  }

  // ----------------------------------------------------------
  // NAV LINK HOVER UNDERLINE ANIMATION
  // ----------------------------------------------------------
  // Desktop nav links (.framer-5HRgQ) have a background
  // rectangle (.framer-btqsd3) that scales from 0 to 1 on
  // hover, creating an underline / highlight effect.
  // ----------------------------------------------------------

  function initNavHover() {
    var navLinks = document.querySelectorAll(
      ".framer-5HRgQ .framer-1kvcrww"
    );
    navLinks.forEach(function (wrap) {
      if (wrap.dataset.navInit) return;
      wrap.dataset.navInit = "true";

      var highlight = wrap.querySelector(".framer-btqsd3");
      if (!highlight) return;

      highlight.style.transition =
        "transform 0.25s cubic-bezier(0.4,0,0.2,1)";

      var parent = wrap.closest(".framer-5HRgQ");
      if (!parent) return;

      parent.addEventListener("mouseenter", function () {
        highlight.style.transform = "scale(1)";
      });
      parent.addEventListener("mouseleave", function () {
        highlight.style.transform = "scale(0)";
      });
    });
  }

  // ----------------------------------------------------------
  // SCROLL-BASED NAV BACKGROUND OPACITY
  // ----------------------------------------------------------
  // The desktop nav bar starts transparent and gains a solid
  // background on scroll.  We interpolate the opacity based
  // on scroll position for a smooth fade-in.
  // ----------------------------------------------------------

  function initNavScrollEffect() {
    var navContainer = document.querySelector(
      '.framer-1lqbvh1-container[name="Nav Static"]'
    );
    if (!navContainer) return;

    var desktopNav = navContainer.querySelector(
      '.framer-ei07s[data-framer-name="TP D"]'
    );
    if (!desktopNav) return;

    // Only apply on desktop widths
    function onScroll() {
      if (window.innerWidth < 1200) return;
      var scrollY = window.scrollY || window.pageYOffset;
      var threshold = 80;
      var opacity = Math.min(scrollY / threshold, 1);

      // Blend from transparent to the page background color
      var bg = "rgba(250, 250, 250, " + (opacity * 0.95) + ")";
      desktopNav.style.backgroundColor = bg;
      desktopNav.style.backdropFilter =
        opacity > 0.1 ? "blur(12px)" : "none";
      desktopNav.style.webkitBackdropFilter =
        opacity > 0.1 ? "blur(12px)" : "none";
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // ----------------------------------------------------------
  // INITIALISE EVERYTHING ON DOM READY
  // ----------------------------------------------------------

  function init() {
    initAccordions();
    initMobileMenu();
    initSmoothScroll();
    initCTAHover();
    initNavHover();
    initNavScrollEffect();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
