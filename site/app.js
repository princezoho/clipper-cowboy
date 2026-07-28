/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD
 *
 * Read top-to-bottom. Each value is milliseconds after trigger.
 *
 *    0ms   hero Pool still establishes beside the headline
 *  180ms   kicker and headline rise into frame
 *  620ms   supporting copy fades in
 *  980ms   calls to action settle in
 *    0ms   editorial chapters wait below the fold
 *  120ms   each chapter rises into the sequence
 * scroll   real screenshots shift within their frame
 * ───────────────────────────────────────────────────────── */

const TIMING = {
  heroTitle:      180, // kicker and headline appear
  heroDeck:       620, // supporting copy appears
  heroActions:    980, // calls to action appear
  sectionReveal:  120, // scrolled chapter appears
};

const OBSERVER = {
  rootMargin: "0px 0px -12% 0px", // trigger before the section is centered
  threshold: 0.14, // visible portion required for a reveal
};

const PARALLAX = {
  selector: "[data-parallax]", // real product image panels
  rate: 0.035, // pixels shifted for each pixel from viewport center
  maxOffset: 32, // maximum vertical panel shift in pixels
  unit: "px", // CSS custom property unit
};

const STAGE = {
  visible: "stage-1", // base content reveal
  heroDeck: "stage-2", // hero supporting copy reveal
  heroActions: "stage-3", // hero calls to action reveal
};

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const heroContent = document.querySelector(".hero-content");
const revealTargets = [...document.querySelectorAll("[data-stage-target]:not(.hero-content)")];
const parallaxTargets = [...document.querySelectorAll(PARALLAX.selector)];
const header = document.querySelector(".site-header");
const menuToggle = document.querySelector(".menu-toggle");
const headerNav = document.querySelector(".header-nav");

function revealHero() {
  if (!heroContent) return;

  if (reducedMotion) {
    heroContent.classList.add(STAGE.visible, STAGE.heroDeck, STAGE.heroActions);
    return;
  }

  window.setTimeout(() => heroContent.classList.add(STAGE.visible), TIMING.heroTitle);
  window.setTimeout(() => heroContent.classList.add(STAGE.heroDeck), TIMING.heroDeck);
  window.setTimeout(() => heroContent.classList.add(STAGE.heroActions), TIMING.heroActions);
}

function revealSections() {
  if (reducedMotion || !("IntersectionObserver" in window)) {
    revealTargets.forEach((target) => target.classList.add(STAGE.visible));
    return;
  }

  const observer = new IntersectionObserver((entries, activeObserver) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;

      window.setTimeout(() => entry.target.classList.add(STAGE.visible), TIMING.sectionReveal);
      activeObserver.unobserve(entry.target);
    });
  }, OBSERVER);

  revealTargets.forEach((target) => observer.observe(target));

  // A late-loading font or restored scroll position can occasionally move a
  // target past the observer's threshold. Keep content readable even then.
  window.setTimeout(() => {
    revealTargets.forEach((target) => {
      const rect = target.getBoundingClientRect();
      if (rect.top < window.innerHeight * 1.15 && rect.bottom > 0) {
        target.classList.add(STAGE.visible);
        observer.unobserve(target);
      }
    });
  }, 1800);
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function updateParallax() {
  if (reducedMotion) return;

  const viewportCenter = window.innerHeight / 2;
  parallaxTargets.forEach((target) => {
    const rect = target.getBoundingClientRect();
    const distance = rect.top + rect.height / 2 - viewportCenter;
    const offset = clamp(distance * PARALLAX.rate, -PARALLAX.maxOffset, PARALLAX.maxOffset);
    target.style.setProperty("--media-parallax", `${offset}${PARALLAX.unit}`);
  });
}

function updateHeader() {
  if (!header) return;
  header.classList.toggle("is-scrolled", window.scrollY > 24);
}

function closeMenu() {
  if (!header || !menuToggle) return;
  header.classList.remove("menu-open");
  menuToggle.setAttribute("aria-expanded", "false");
}

if (menuToggle && header) {
  menuToggle.addEventListener("click", () => {
    const isOpen = header.classList.toggle("menu-open");
    menuToggle.setAttribute("aria-expanded", String(isOpen));
  });
}

if (headerNav) {
  headerNav.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeMenu();
  });
}

revealHero();
revealSections();
updateParallax();
updateHeader();
window.addEventListener("scroll", () => {
  updateParallax();
  updateHeader();
}, { passive: true });
window.addEventListener("resize", updateParallax);
