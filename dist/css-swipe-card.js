class CssSwipeCard extends HTMLElement {
  static get version() {
    return 'v2026.7';
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.currentIndex = 0;
    this.resizeObserver = null;
  }

  // Core setup and rendering methods
  setConfig(config) {
    if (!config || !config.cards || !Array.isArray(config.cards)) {
      throw new Error('You need to define cards');
    }

    this.cardId = config.cardId || `css-swipe-card-${Math.random().toString(36).substr(2, 9)}`;

    this.config = {
      width: '100%',
      template: 'slider-horizontal',
      auto_height: false,
      card_gap: '0px',
      card_padding: null,
      timer: 0,
      pagination: false,
      pagination_position: 'overlay',
      navigation: false,
      navigation_next: '',
      navigation_prev: '',
      custom_css: {},
      current_slide_entity: null,
      slide_css_variable: null,
      cardId: this.cardId,
      ...config
    };

    // `card_padding` is the breathing room the slider keeps around each slide so
    // that box-shadows on the nested cards are not sheared off by the scroll
    // container. When it is not given we fall back to `card_gap`, which is what
    // the side padding used to be hard-wired to — that keeps existing configs
    // looking the way they did.
    this.paddingIsExplicit = this.config.card_padding !== null;
    if (!this.paddingIsExplicit) {
      this.config.card_padding = this.config.card_gap;
    }

    this.render();
  }

  async render() {
    const styles = this.getStyles();
    const html = this.getHtml();

    this.shadowRoot.innerHTML = `<style>${styles}</style>${html}`;

    const cardContainer = this.shadowRoot.querySelector(`.${this.config.template}`);
    this._cards = [];

    for (const [index, cardConfig] of this.config.cards.entries()) {
      const card = await this.createCardElement(cardConfig);
      const slide = document.createElement('div');
      slide.classList.add('slide');
      slide.style.width = '100%';
      slide.dataset.index = index;
      card.classList.add('card-element');
      slide.appendChild(card);
      cardContainer.appendChild(slide);
      this._cards.push(card);
    }

    if (this.config.auto_height) {
      this.setupResizeObserver();
    } else {
      await this.setManualHeight();
    }

    this.applyCustomStyles();

    if (this.config.pagination) {
      this.setupPagination();
    }

    if (this.config.navigation) {
      this.setupNavigation();
    }

    this.setupTimer();
    this.publishSlideCssVariables();

    // Returning from the background is not guaranteed to resize anything, so
    // the ResizeObserver may never fire to undo a collapsed layout. Re-measure
    // explicitly once the document is visible again.
    if (!this._onVisibilityChange) {
      this._onVisibilityChange = () => {
        if (!document.hidden) {
          this.adjustCardContainerHeight();
        }
      };
      document.addEventListener('visibilitychange', this._onVisibilityChange);
    }

    const slider = this.shadowRoot.querySelector(`.${this.config.template}`);
    slider.addEventListener('scroll', () => {
      this.updateCurrentIndex();
      this.updatePagination();
    });
    
    if (this._hass) {
      this.checkInputNumberState();
    }
  }

  // HTML and CSS generation methods
  getStyles() {
    const pad = this.config.card_padding;
    // Cross-axis padding and the matching negative margin only apply when
    // card_padding was set explicitly; without it we reproduce the old layout,
    // where the side padding simply tracked card_gap.
    const padCross = this.paddingIsExplicit ? pad : '0px';
    const marginInline = this.paddingIsExplicit ? `calc(-1 * ${pad})` : '0px';
    // The block axis needs the same cancellation. Only the inline one used to be
    // undone, so the padding stayed in layout: the slider sat `card_padding`
    // lower than whatever it was lined up against and measured `2 * card_padding`
    // taller than the cards inside it.
    const marginBlock = this.paddingIsExplicit ? `calc(-1 * ${pad})` : '0px';
    // A neighbouring slide sits flush against the clip edge, so its shadow
    // bleeds into view unless the gap clears the padding by a shadow's width.
    const gapFloor = (this.paddingIsExplicit && parseFloat(pad) > 0)
      ? `calc(${pad} + var(--slides-shadow-clearance))`
      : '0px';
    // The wrapper must not clip the overhang the slider reclaims with its
    // negative margin. `visible` is the baseline because WebKit does not
    // implement overflow-clip-margin — under `clip` it would ignore the margin
    // and shear the side shadows off. The safer `clip` form, which cannot
    // produce a stray scrollbar, is layered on below where it is supported.
    const wrapperOverflow = this.paddingIsExplicit ? 'visible' : 'hidden';
    const wrapperClipSupport = this.paddingIsExplicit
      ? `@supports (overflow-clip-margin: 1px) {
        #${this.cardId} {
          overflow: clip;
          overflow-clip-margin: ${pad};
        }
      }`
      : '';
    return `
      :host {
        --slides-gap: ${this.config.card_gap};
        --slides-padding: ${pad};
        --slides-shadow-clearance: 6px;
        --slides-align-items: center;
        --pagination-bullet-active-background-color: var(--primary-text-color);
        --pagination-bullet-background-color: var(--primary-background-color);
        --pagination-bullet-border: 1px solid #999;
        --pagination-bullet-distance: 10px;
        --navigation-button-next-color: var(--primary-text-color);
        --navigation-button-next-background-color: var(--primary-background-color);
        --navigation-button-next-width: 40px;
        --navigation-button-next-height: 40px;
        --navigation-button-next-border-radius: 100%;
        --navigation-button-next-border: none;
        --navigation-button-prev-color: var(--primary-text-color);
        --navigation-button-prev-background-color: var(--primary-background-color);
        --navigation-button-prev-width: 40px;
        --navigation-button-prev-height: 40px;
        --navigation-button-prev-border-radius: 100%;
        --navigation-button-prev-border: none;
        --navigation-button-distance: 10px;
      }
      #${this.cardId} {
        position: relative;
        overflow: ${wrapperOverflow};

        /* Force hardware acceleration with 3D transform */
        transform: translateZ(0);
        -webkit-transform: translateZ(0);
        -moz-transform: translateZ(0);
        -ms-transform: translateZ(0);
        -o-transform: translateZ(0);

        /* Existing properties */
        backface-visibility: hidden;
        perspective: 1000;
        -webkit-backface-visibility: hidden;
        -webkit-perspective: 1000;
        -moz-backface-visibility: hidden;
        -moz-perspective: 1000;
        -ms-backface-visibility: hidden;
        -ms-perspective: 1000;
    
        will-change: transform;
        -webkit-overflow-scrolling: touch;
      }
      ${wrapperClipSupport}
      #${this.cardId} .slider-horizontal {
        display: flex;
        /* content-box is load-bearing: adjustCardContainerHeight() assigns an
           inline height measured with getBoundingClientRect(), which excludes
           shadows. Under border-box the padding would eat that height and
           squeeze the cards instead of freeing the shadow. */
        box-sizing: content-box;
        overflow-x: auto;
        overflow-y: hidden;
        scroll-snap-type: x mandatory;
        scroll-behavior: smooth;
        position: relative;
        gap: max(var(--slides-gap), ${gapFloor});
        padding-inline: ${pad};
        padding-block: ${padCross};
        /* Cancel the padding in layout on both axes so the slide keeps its full
           width and the card occupies exactly the space it would without a
           slider around it; the padding box grows outward over the clip margin
           instead. */
        margin-inline: ${marginInline};
        margin-block: ${marginBlock};
        scroll-padding-inline: ${pad};
      }
      #${this.cardId} .slider-vertical {
        display: flex;
        flex-direction: column;
        box-sizing: content-box;
        overflow-y: auto;
        overflow-x: hidden;
        scroll-snap-type: y mandatory;
        scroll-behavior: smooth;
        position: relative;
        gap: max(var(--slides-gap), ${gapFloor});
        padding-block: ${pad};
        padding-inline: ${padCross};
        margin-inline: ${marginInline};
        margin-block: ${marginBlock};
        scroll-padding-block: ${pad};
      }
      #${this.cardId} .slider-horizontal,
      #${this.cardId} .slider-vertical {
        &::-webkit-scrollbar {
          display: none;
        }
        scrollbar-width: none;
        -ms-overflow-style: none;
        
      }
      #${this.cardId} .slide {
        display: flex;
        min-width: 100%;
        align-items: var(--slides-align-items);
        justify-content: center;
        scroll-snap-align: start;
      }
      #${this.cardId} .card-element {
        width: 100% !important;
        scroll-snap-align: start;
        scroll-snap-stop: always;
      }
      #${this.cardId} .pagination-control.horizontal {
        position: absolute;
        bottom: var(--pagination-bullet-distance);
        left: 50%;
        align-items: center;
        transform: translateX(-50%);
        display: flex;
        gap: 10px;
      }
      #${this.cardId} .pagination-control.horizontal.below {
        /* In normal flow the bullets sit under the slides and claim their own
           height, instead of floating on top of the bottom card. */
        position: static;
        transform: none;
        justify-content: center;
        margin-top: var(--pagination-bullet-distance);
      }
      #${this.cardId} .pagination-control.vertical {
        position: absolute;
        top: 50%;
        right: var(--pagination-bullet-distance);
        align-items: center;
        transform: translateY(-50%);
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      #${this.cardId} .pagination-bullet {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background-color: var(--pagination-bullet-background-color, var(--primary-background-color));
          border: var(--pagination-bullet-border, 1px solid #999);
          cursor: pointer;
          padding: 0;
          transition: all 0.3s ease;
      }
      #${this.cardId} .pagination-bullet.active {
          background-color: var(--pagination-bullet-active-background-color, var(--primary-text-color));
          width: 12px;
          height: 12px;
      }
      #${this.cardId} .navigation-button {
        position: absolute;
        border: none;
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1;
        transition: transform 0.1s;
      }
      #${this.cardId} .navigation-button:active {
        animation: buttonPress 0.2s ease-out;
      }
      #${this.cardId} .navigation-button.prev-horizontal {
        width: var(--navigation-button-prev-width);
        height: var(--navigation-button-prev-height);
        left: var(--navigation-button-distance);
        top: 50%;
        margin-top: calc(-1 * var(--navigation-button-prev-height) / 2);
        color: var(--navigation-button-prev-color);
        background: var(--navigation-button-prev-background-color);
        border-radius: var(--navigation-button-prev-border-radius);
        border: var(--navigation-button-prev-border);
        transition: transform 0.1s;
      }
      #${this.cardId} .navigation-button.next-horizontal {
        width: var(--navigation-button-next-width);
        height: var(--navigation-button-next-height);
        right: var(--navigation-button-distance);
        top: 50%;
        margin-top: calc(-1 * var(--navigation-button-next-height) / 2);
        color: var(--navigation-button-next-color);
        background: var(--navigation-button-next-background-color);
        border-radius: var(--navigation-button-next-border-radius);
        border: var(--navigation-button-next-border);
        transition: transform 0.1s;
      }
      #${this.cardId} .navigation-button.prev-vertical {
        width: var(--navigation-button-prev-width);
        height: var(--navigation-button-prev-height);
        top: var(--navigation-button-distance);
        left: 50%;
        margin-left: calc(-1 * var(--navigation-button-prev-width) / 2);
        color: var(--navigation-button-prev-color);
        background: var(--navigation-button-prev-background-color);
        border-radius: var(--navigation-button-prev-border-radius);
        border: var(--navigation-button-prev-border);
        transition: transform 0.1s;
      }
      #${this.cardId} .navigation-button.next-vertical {
        width: var(--navigation-button-next-width);
        height: var(--navigation-button-next-height);
        bottom: var(--navigation-button-distance);
        left: 50%;
        margin-left: calc(-1 * var(--navigation-button-next-width) / 2);
        color: var(--navigation-button-next-color);
        background: var(--navigation-button-next-background-color);
        border-radius: var(--navigation-button-next-border-radius);
        border: var(--navigation-button-next-border);
        transition: transform 0.1s;
      }
      #${this.cardId} .navigation-button ha-icon {
        width: 80%;
        height: 80%;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #${this.cardId} .navigation-button, #${this.cardId} .pagination-control label {
        -webkit-tap-highlight-color: transparent;
        outline: none;
      }
      #${this.cardId} .navigation-button ha-icon,
      #${this.cardId} .pagination-control label {
        pointer-events: none;
      }
      @keyframes buttonPress {
        0% {
          transform: scale(1);
        }
        50% {
          transform: scale(0.9);
        }
        100% {
          transform: scale(1);
        }
      }
    `;
  }

  getHtml() {
    return `
      <div id="${this.cardId}">
        <div class="${this.config.template}"></div>
        ${this.config.pagination ? `<div class="pagination-control ${this.config.template === 'slider-horizontal' ? 'horizontal' : 'vertical'}${this.config.pagination_position === 'below' ? ' below' : ''}"></div>` : ''}
        ${this.config.navigation ? `
          <button class="navigation-button prev-${this.config.template === 'slider-horizontal' ? 'horizontal' : 'vertical'}">
            ${this.config.navigation_prev ? `<ha-icon icon="${this.config.navigation_prev}"></ha-icon>` : (this.config.template === 'slider-horizontal' ? '&lt;' : '&uarr;')}
          </button>
          <button class="navigation-button next-${this.config.template === 'slider-horizontal' ? 'horizontal' : 'vertical'}">
            ${this.config.navigation_next ? `<ha-icon icon="${this.config.navigation_next}"></ha-icon>` : (this.config.template === 'slider-horizontal' ? '&gt;' : '&darr;')}
          </button>
        ` : ''}
      </div>
    `;
  }

  // Card creation and sizing methods
  async createCardElement(cardConfig) {
    const createCard = (await loadCardHelpers()).createCardElement;
    const element = createCard(cardConfig);
    element.hass = this._hass;
    return element;
  }

  async getCardSize() {
    if (!this._cards) {
      return 0;
    }

    let maxHeight = 0;

    for (const card of this._cards) {
      if (card.getCardSize) {
        const size = await card.getCardSize();
        maxHeight = Math.max(maxHeight, size * 50);
      } else {
        await card.updateComplete;
        const rect = card.getBoundingClientRect();
        maxHeight = Math.max(maxHeight, rect.height);
      }
    }

    return maxHeight || 140; // fallback to 140 if maxHeight is 0
  }

  async getMaxCardHeight() {
    let maxHeight = 0;
    for (const card of this._cards) {
      await card.updateComplete;  // Ensure card is fully rendered
      // Release any height we pinned earlier before measuring. Otherwise we
      // measure our own previous output instead of the card's natural height,
      // which makes a single bad reading permanent and stops auto_height from
      // ever following content that grows.
      const pinned = card.style.height;
      card.style.height = 'auto';
      const rect = card.getBoundingClientRect();
      card.style.height = pinned;
      maxHeight = Math.max(maxHeight, rect.height);
    }
    return maxHeight || 140;  // Fallback height
  }

  // Card container height adjustment methods
  async adjustCardContainerHeight() {
    // A hidden document — backgrounded app, inactive tab — lays every element
    // out at ~0. Measuring then and writing the result back would pin the cards
    // to a collapsed height that survives the return to the foreground.
    if (document.hidden || !this.isConnected) {
      return;
    }

    const cardContainer = this.shadowRoot.querySelector(`.${this.config.template}`);
    const slideContainer = this.shadowRoot.querySelector(`.slide`);
    const maxHeight = await this.getMaxCardHeight();

    if (this.config.auto_height) {
        this._cards.forEach(card => {
            card.style.height = `${maxHeight}px`;
        });
        cardContainer.style.height = `${maxHeight}px`;
        slideContainer.style.height = `${maxHeight}px`;
    } else {
        cardContainer.style.height = `${maxHeight}px`;
        slideContainer.style.height = `${maxHeight}px`;
        this._cards.forEach(card => {
            card.style.height = 'auto';  // Keeps native height for cards
        });
    }

    if (this.config.height && !this.config.auto_height) {
        cardContainer.style.height = this.config.height;
        slideContainer.style.height = this.config.height;
        this._cards.forEach(card => {
            card.style.height = this.config.height;
        });
    }
  }

  async setManualHeight() {
    const cardContainer = this.shadowRoot.querySelector(`.${this.config.template}`);
    const isHorizontal = this.config.template === 'slider-horizontal';

    if (isHorizontal) {
      cardContainer.style.height = this.config.height;
      cardContainer.style.overflowY = 'hidden';
    } else {
      // For vertical mode
      const maxHeight = await this.getMaxCardHeight();
      cardContainer.style.height = this.config.height || `${maxHeight}px`;
      cardContainer.style.overflowY = 'auto';
    }

    this._cards.forEach(card => {
      if (isHorizontal) {
        card.style.height = this.config.height;
      } else {
        card.style.height = 'auto'; // Keep native height for cards in vertical mode
      }
    });
  }

  // Resize observer setup
  setupResizeObserver() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }

    this.resizeObserver = new ResizeObserver(() => {
      this.adjustCardContainerHeight();
      this.updateCurrentIndex();
      this.updatePagination();
    });

    this._cards.forEach(card => {
      this.resizeObserver.observe(card);
    });
  }

  // The slides are separated by `gap`, so the distance between two snap points
  // is one card plus one gap — never the card alone. Read it back from the
  // computed style rather than config.card_gap, because the rendered value is
  // floored at `card_padding + var(--slides-shadow-clearance)` and can be
  // larger than what was configured.
  getSlideGap(slider, isHorizontal) {
    const styles = getComputedStyle(slider);
    const gap = parseFloat(isHorizontal ? styles.columnGap : styles.rowGap);
    return isNaN(gap) ? 0 : gap;
  }

  // Current index update method
  updateCurrentIndex() {
    const slider = this.shadowRoot.querySelector(`.${this.config.template}`);
    const isHorizontal = this.config.template === 'slider-horizontal';
    const scrollPosition = isHorizontal ? slider.scrollLeft : slider.scrollTop;
    const viewportSize = isHorizontal ? slider.clientWidth : slider.clientHeight;
    const gap = this.getSlideGap(slider, isHorizontal);

    const previousIndex = this.currentIndex;
    let accumulatedSize = 0;
    for (let i = 0; i < this._cards.length; i++) {
      const cardSize = isHorizontal ? this._cards[i].clientWidth : this._cards[i].clientHeight;
      if (scrollPosition < accumulatedSize + cardSize / 2) {
        this.currentIndex = i;
        break;
      }
      accumulatedSize += cardSize + gap;
    }
    if (this.currentIndex !== previousIndex) {
      this.publishCurrentSlide();
      this.publishSlideCssVariables();
    }
  }

  // Expose the visible slide as CSS custom properties on the document root.
  // Custom properties inherit through shadow roots, so any card on the page can
  // style itself from them - instantly, per device, with no round trip to Home
  // Assistant. `--name` holds the 1-based slide number and `--name-N` is 1 for
  // the visible slide and 0 for the rest, which keeps consumer CSS to calc().
  publishSlideCssVariables() {
    const name = this.slideCssVariableName();
    if (!name || !this._cards) {
      return;
    }
    const root = document.documentElement.style;
    root.setProperty(name, String(this.currentIndex + 1));
    this._cards.forEach((_, i) => {
      root.setProperty(`${name}-${i + 1}`, i === this.currentIndex ? '1' : '0');
    });
  }

  // Leaving the page must not strand the last slide's values on the root,
  // or cards elsewhere would keep reacting to a swiper that is gone.
  clearSlideCssVariables() {
    const name = this.slideCssVariableName();
    if (!name || !this._cards) {
      return;
    }
    const root = document.documentElement.style;
    root.removeProperty(name);
    this._cards.forEach((_, i) => root.removeProperty(`${name}-${i + 1}`));
  }

  slideCssVariableName() {
    const name = this.config.slide_css_variable;
    if (!name) {
      return null;
    }
    return name.startsWith('--') ? name : `--${name}`;
  }

  // Report the visible slide (1-based) to an input_number so other cards can
  // react to it. The inbound input_number.<cardId> helper cannot double for
  // this: a non-zero value there means "scroll to this slide" and is reset to 0.
  // Skipped when the helper already holds the value, so a scroll that stays on
  // the same slide - or a dashboard reload - costs no service call.
  publishCurrentSlide() {
    const entity = this.config.current_slide_entity;
    if (!entity || !this._hass) {
      return;
    }
    const state = this._hass.states[entity];
    const value = this.currentIndex + 1;
    if (!state || parseFloat(state.state) === value) {
      return;
    }
    this._hass.callService('input_number', 'set_value', { entity_id: entity, value })
      .catch((error) => console.error('Failed to publish current slide:', error));
  }

  // Home Assistant integration methods
  set hass(hass) {
    const oldHass = this._hass;
    this._hass = hass;

    if (!oldHass) {
      this.setupInputNumberListener();
      this.checkInputNumberState();
      // A reload starts on the first slide; clear whatever the helper was left at.
      this.publishCurrentSlide();
    }

    const cardContainer = this.shadowRoot.querySelector(`.${this.config.template}`);
    if (cardContainer) {
      cardContainer.childNodes.forEach((child) => {
        if (child.firstChild) {
          child.firstChild.hass = hass;
        }
      });
    }

    const inputNumberEntity = `input_number.${this.config.cardId}`;
    if (oldHass && hass.states[inputNumberEntity] !== oldHass.states[inputNumberEntity]) {
      this.checkInputNumberState();
    }
  }

  setupInputNumberListener() {
    const inputNumberEntity = `input_number.${this.config.cardId}`;
    this._hass.connection.subscribeEvents(
      (event) => this.handleInputNumberChange(event),
      'state_changed',
      { entity_id: inputNumberEntity }
    );
  }

  checkInputNumberState() {
    const inputNumberEntity = `input_number.${this.config.cardId}`;
    const state = this._hass.states[inputNumberEntity];
    if (state) {
      const inputNumber = parseFloat(state.state);
      if (inputNumber !== 0) {
        const calcIndex = this.calcIndex(inputNumber);
        if (calcIndex >= 0) {
          requestAnimationFrame(() => {
            this.scrollToCardByIndex(calcIndex);
            setTimeout(() => {
              this.resetInputNumber();
            }, 500);
          });
        }
      }
    }
  }

  handleInputNumberChange(event) {
    if (event.data.entity_id === `input_number.${this.config.cardId}`) {
      const newState = event.data.new_state;
      if (newState && newState.state) {
        const inputNumber = parseFloat(newState.state);
        if (inputNumber !== 0) {
          const calcIndex = this.calcIndex(inputNumber);
          if (calcIndex >= 0) {
            this.scrollToCardByIndex(calcIndex).then(() => {
              this.resetInputNumber();
            });
          }
        }
      }
    }
  }

  resetInputNumber() {
    if (!this._hass) {
      console.error("HASS not available");
      return;
    }

    const inputNumberEntity = `input_number.${this.config.cardId}`;
    this._hass.callService("input_number", "set_value", {
      entity_id: inputNumberEntity,
      value: 0
    }).catch((error) => {
      console.error("Failed to reset input_number:", error);
    });
  }

  calcIndex(inputNumber) {
    return inputNumber - 1;
  }

  // Pagination setup and update methods
  setupPagination() {
    const paginationControl = this.shadowRoot.querySelector('.pagination-control');
    if (!paginationControl) return;

    // Clear existing pagination bullets
    paginationControl.innerHTML = '';

    this._cards.forEach((_, index) => {
      const bullet = document.createElement('button');
      bullet.classList.add('pagination-bullet');
      bullet.setAttribute('aria-label', `Go to slide ${index + 1}`);
      bullet.addEventListener('click', () => this.scrollToCard(index));
      paginationControl.appendChild(bullet);
    });

    this.updatePagination();
  }

  updatePagination() {
    const paginationControl = this.shadowRoot.querySelector('.pagination-control');
    if (!paginationControl) return;

    const bullets = paginationControl.querySelectorAll('.pagination-bullet');
    bullets.forEach((bullet, index) => {
      if (index === this.currentIndex) {
        bullet.classList.add('active');
        bullet.setAttribute('aria-current', 'true');
      } else {
        bullet.classList.remove('active');
        bullet.removeAttribute('aria-current');
      }
    });
  }

  // Navigation setup and methods
  setupNavigation() {
    const prevButton = this.shadowRoot.querySelector('.navigation-button.prev-horizontal, .navigation-button.prev-vertical');
    const nextButton = this.shadowRoot.querySelector('.navigation-button.next-horizontal, .navigation-button.next-vertical');
    if (prevButton) prevButton.addEventListener('click', () => this.navigate(-1));
    if (nextButton) nextButton.addEventListener('click', () => this.navigate(1));
  }

  navigate(direction) {
    const newIndex = Math.max(0, Math.min(this.currentIndex + direction, this._cards.length - 1));
    this.scrollToCard(newIndex);
  }

  // Card scrolling methods
  scrollToCard(index) {
    const slider = this.shadowRoot.querySelector(`.${this.config.template}`);
    if (!slider) return;

    const isHorizontal = this.config.template === 'slider-horizontal';
    const gap = this.getSlideGap(slider, isHorizontal);
    let scrollPosition = 0;

    for (let i = 0; i < index; i++) {
      scrollPosition += (isHorizontal ? this._cards[i].clientWidth : this._cards[i].clientHeight) + gap;
    }

    slider.scrollTo({
      [isHorizontal ? 'left' : 'top']: scrollPosition,
      behavior: 'smooth'
    });

    this.updateCurrentIndex();
    this.updatePagination();

    if (this.config.timer > 0) {
      this.resetTimer();
    }
  }

  scrollToCardByIndex(index) {
    return new Promise((resolve) => {
      const slider = this.shadowRoot.querySelector(`.${this.config.template}`);
      if (!slider) {
        resolve();
        return;
      }
      const isHorizontal = this.config.template === 'slider-horizontal';
      const maxIndex = this._cards.length - 1;
      const safeIndex = Math.max(0, Math.min(Math.round(index), maxIndex));
      // Step by the slide itself plus the gap. clientWidth was standing in for
      // that, which only matched while `2 * card_padding` happened to equal the
      // gap — it drifts by a whole slide once either value changes.
      const first = this._cards[0];
      const slideSize = first
        ? (isHorizontal ? first.clientWidth : first.clientHeight)
        : (isHorizontal ? slider.clientWidth : slider.clientHeight);
      const scrollPosition = safeIndex * (slideSize + this.getSlideGap(slider, isHorizontal));
    
      const scrollEndHandler = () => {
        slider.removeEventListener('scrollend', scrollEndHandler);
        this.updatePagination();
        resolve();
      };
    
      slider.addEventListener('scrollend', scrollEndHandler);
    
      slider.scrollTo({
        [isHorizontal ? 'left' : 'top']: scrollPosition,
        behavior: 'smooth'
      });
    });
  }

  // Timer setup and reset methods
  setupTimer() {
    if (this.config.timer > 0) {
      this.resetTimer();
      const slider = this.shadowRoot.querySelector(`.${this.config.template}`);
      slider.addEventListener('scroll', () => this.resetTimer());
      slider.addEventListener('click', () => this.resetTimer());
      slider.addEventListener('touchend', () => this.resetTimer());
    }
  }

  resetTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }
    this.timerInterval = setTimeout(() => {
      const slider = this.shadowRoot.querySelector(`.${this.config.template}`);
      this.scrollToCard(0);
    }, this.config.timer * 1000);
  }

  // Cleanup method
  // Home Assistant can detach and re-attach a card without rebuilding it, and
  // disconnectedCallback cleared the variables on the way out.
  connectedCallback() {
    this.publishSlideCssVariables();
  }

  disconnectedCallback() {
    this.clearSlideCssVariables();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }
    if (this._onVisibilityChange) {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
      this._onVisibilityChange = null;
    }
  }

  // Custom styles application method
  applyCustomStyles() {
    const style = document.createElement('style');
    style.textContent = Object.entries(this.config.custom_css)
      .map(([property, value]) => `#${this.cardId} { ${property}: ${value}; }`)
      .join('\n');
    this.shadowRoot.appendChild(style);
  }
}

customElements.define('css-swipe-card', CssSwipeCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "css-swipe-card",
  name: "CSS Swipe Card",
  description: "A custom swipe card and carousel"
});
