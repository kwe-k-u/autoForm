// ============================================================
// AutoForm Landing Page – Interactive Behaviors
// ============================================================

(function () {
  "use strict";

  // Comes from firebase-config.js (generated from .env via scripts/gen-firebase-config.js, committed).
  var DATABASE_URL = (globalThis.FIREBASE_CONFIG && globalThis.FIREBASE_CONFIG.databaseURL) || "";

  // Mobile nav toggle
  function initMobileNav() {
    var toggle = document.getElementById("nav-toggle");
    var nav = document.getElementById("site-nav");
    if (!toggle || !nav) return;

    toggle.addEventListener("click", function () {
      var isOpen = nav.classList.toggle("open");
      toggle.classList.toggle("open", isOpen);
      toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });

    nav.querySelectorAll(".nav-links a").forEach(function (link) {
      link.addEventListener("click", function () {
        nav.classList.remove("open");
        toggle.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  // Close other open FAQ items when one opens (single-open accordion)
  function initFaq() {
    var items = document.querySelectorAll(".faq-item");
    items.forEach(function (item) {
      item.addEventListener("toggle", function () {
        if (!item.open) return;
        items.forEach(function (other) {
          if (other !== item) other.open = false;
        });
      });
    });
  }

  // Hero image carousel
  function initHeroCarousel() {
    var carousel = document.getElementById("hero-carousel");
    if (!carousel) return;

    var slides = carousel.querySelectorAll(".hero-slide");
    if (slides.length < 2) return;

    var current = 0;
    setInterval(function () {
      slides[current].classList.remove("is-active");
      current = (current + 1) % slides.length;
      slides[current].classList.add("is-active");
    }, 5000);
  }

  // Waitlist form submission
  function initWaitlistForm() {
    var form = document.getElementById("waitlist-form");
    if (!form) return;

    var submitBtn = document.getElementById("submit-btn");
    var formContainer = document.getElementById("form-container");
    var successMessage = document.getElementById("success-message");

    form.addEventListener("submit", function (e) {
      e.preventDefault();

      submitBtn.disabled = true;
      submitBtn.textContent = "Submitting...";

      var formData = {
        email: document.getElementById("email").value,
        persona: document.getElementById("persona").value,
        painPoint: document.getElementById("pain-point").value,
        ageRange: document.getElementById("age-range").value,
        timestamp: new Date().toISOString(),
      };

      // Local backup copy, independent of whether the database write succeeds.
      var waitlist = JSON.parse(localStorage.getItem("autoform-waitlist") || "[]");
      waitlist.push(formData);
      localStorage.setItem("autoform-waitlist", JSON.stringify(waitlist));

      function showSuccess() {
        formContainer.style.display = "none";
        successMessage.classList.add("show");
      }

      if (!DATABASE_URL) {
        console.warn("DATABASE_URL isn't set (firebase-config.js missing or FIREBASE_DATABASE_URL unset in .env) — signup saved locally only.");
        showSuccess();
        return;
      }

      // POSTing to <path>.json is the Realtime Database REST API — it appends
      // a new push-ID'd entry under "waitlist", equivalent to push().
      fetch(DATABASE_URL + "/waitlist.json", {
        method: "POST",
        body: JSON.stringify(formData),
      })
        .catch(function (err) {
          console.error("Failed to send signup to the waitlist database:", err);
        })
        .finally(showSuccess);
    });
  }

  // Smooth scroll + close mobile nav for in-page anchor links
  function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(function (link) {
      link.addEventListener("click", function (e) {
        var targetId = this.getAttribute("href");
        if (!targetId || targetId === "#") return;
        var target = document.querySelector(targetId);
        if (!target) return;
        e.preventDefault();
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        if (history.pushState) history.pushState(null, null, targetId);
      });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    initMobileNav();
    initHeroCarousel();
    initFaq();
    initWaitlistForm();
    initSmoothScroll();
  });
})();
