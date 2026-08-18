// ============================================================
// AutoForm Landing Page – Interactive Behaviors
// ============================================================

(function () {
  "use strict";

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
        purpose: document.getElementById("purpose").value,
        country: document.getElementById("country").value,
        ageRange: document.getElementById("age-range").value,
        timestamp: new Date().toISOString(),
      };

      var waitlist = JSON.parse(localStorage.getItem("autoform-waitlist") || "[]");
      waitlist.push(formData);
      localStorage.setItem("autoform-waitlist", JSON.stringify(waitlist));

      formContainer.style.display = "none";
      successMessage.classList.add("show");
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
    initFaq();
    initWaitlistForm();
    initSmoothScroll();
  });
})();
