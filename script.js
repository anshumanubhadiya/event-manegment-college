// Script for testimonial slider and small interactivity
// Intended as a lightweight mockup, replace or extend with framework code as needed.

document.addEventListener('DOMContentLoaded', () => {
  // Simple slider
  const slidesContainer = document.querySelector('.slides');
  const slides = Array.from(document.querySelectorAll('.slide'));
  const prevBtn = document.querySelector('.slide-btn.prev');
  const nextBtn = document.querySelector('.slide-btn.next');
  let index = 0;
  const total = slides.length;

  // Stack slides horizontally
  slidesContainer.style.display = 'flex';
  slidesContainer.style.transition = 'transform 0.7s cubic-bezier(.2,.9,.3,1)';
  slides.forEach(sl => { sl.style.minWidth = '100%'; sl.style.boxSizing = 'border-box'; });

  function goTo(i){
    index = (i + total) % total;
    slidesContainer.style.transform = `translateX(-${index * 100}%)`;
  }

  prevBtn?.addEventListener('click', () => goTo(index - 1));
  nextBtn?.addEventListener('click', () => goTo(index + 1));

  // autoplay
  let autoplay = setInterval(() => goTo(index + 1), 4500);

  // pause on hover
  const slider = document.querySelector('.testimonial-slider');
  slider?.addEventListener('mouseenter', () => clearInterval(autoplay));
  slider?.addEventListener('mouseleave', () => autoplay = setInterval(() => goTo(index + 1), 4500));

  // small smooth hover parallax for hero card
  const heroCard = document.querySelector('.hero-card');
  if(heroCard){
    heroCard.addEventListener('mousemove', (e) => {
      const r = heroCard.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      heroCard.style.transform = `perspective(1000px) rotateX(${ -y * 6 }deg) rotateY(${ x * 6 }deg) translateY(-6px)`;
    });
    heroCard.addEventListener('mouseleave', () => { heroCard.style.transform = ''; });
  }
});