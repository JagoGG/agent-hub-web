(() => {
  const compositionId = 'agent-hub-showcase';
  const timeline = window.gsap.timeline({ paused: true });

  timeline
    .to('.scanline', { y: 780, duration: 12, ease: 'none' }, 0)
    .fromTo('.frame-intro', { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.55 }, 0)
    .from('.frame-intro .eyebrow', { y: 16, autoAlpha: 0, duration: 0.45 }, 0.1)
    .from('.frame-intro h1', { y: 38, autoAlpha: 0, duration: 0.75, ease: 'power3.out' }, 0.2)
    .from('.frame-intro .lede', { y: 20, autoAlpha: 0, duration: 0.55 }, 0.55)
    .from('.orbit-one', { scale: 0.55, rotation: -45, autoAlpha: 0, duration: 1.1, ease: 'power3.out' }, 0.25)
    .from('.orbit-two', { scale: 0.55, rotation: 55, autoAlpha: 0, duration: 1.2, ease: 'power3.out' }, 0.38)
    .from('.core', { scale: 0.25, autoAlpha: 0, duration: 0.75, ease: 'back.out(1.7)' }, 0.65)
    .to('.orbit-one', { rotation: 24, duration: 3.1, ease: 'none' }, 0.9)
    .to('.orbit-two', { rotation: -32, duration: 3.1, ease: 'none' }, 0.9)
    .to('.frame-intro', { autoAlpha: 0, y: -24, duration: 0.55 }, 3.55)
    .fromTo('.frame-network', { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.5 }, 3.65)
    .from('.frame-network h2', { x: -40, autoAlpha: 0, duration: 0.65, ease: 'power3.out' }, 3.8)
    .from('.network path', { strokeDashoffset: 90, autoAlpha: 0, duration: 1.2 }, 4)
    .from('.node-main', { scale: 0.55, autoAlpha: 0, duration: 0.5, ease: 'back.out(1.7)' }, 4.1)
    .from('.node:not(.node-main)', { scale: 0.72, autoAlpha: 0, duration: 0.4, stagger: 0.18 }, 4.45)
    .to('.node', { borderColor: '#48e7c7', duration: 0.22, stagger: 0.13, yoyo: true, repeat: 1 }, 6.35)
    .to('.frame-network', { autoAlpha: 0, x: 28, duration: 0.55 }, 7.65)
    .fromTo('.frame-outro', { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.55 }, 7.8)
    .from('.mark', { scale: 0.35, rotation: -10, autoAlpha: 0, duration: 0.65, ease: 'back.out(1.7)' }, 7.95)
    .from('.outro-lockup h2, .outro-lockup p', { x: 34, autoAlpha: 0, duration: 0.55, stagger: 0.13 }, 8.12)
    .from('.command', { y: 24, autoAlpha: 0, duration: 0.55 }, 8.65)
    .to('.mark', { boxShadow: '0 0 80px rgba(255, 106, 61, 0.36)', duration: 1.4, yoyo: true, repeat: 1 }, 9.1);

  window.__timelines = window.__timelines || {};
  window.__timelines[compositionId] = timeline;
})();
