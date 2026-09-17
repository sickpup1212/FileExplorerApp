class PinModal extends HTMLElement {
  constructor() {
      super();
      this.correctPin = this.getAttribute('correct-pin');
      this.attempts = 0;
      this.maxAttempts = 3;
  }

  connectedCallback() {
      this.setAttribute('active', '');
      this.render();
      this.setupEventListeners();
  }

  render() {
      this.innerHTML = `
          <div class="modal-content">
              <h2>Enter 6-digit PIN</h2>
              <input type="text" id="pin-input" maxlength="6" inputmode="numeric" pattern="[0-9]*" autocomplete="off">
              <br>
              <button id="submit-pin">Submit</button>
              <p id="error-message"></p>
          </div>
      `;
  }

  setupEventListeners() {
      const input = this.querySelector('#pin-input');
      const submitButton = this.querySelector('#submit-pin');
      const errorMessage = this.querySelector('#error-message');

      input.addEventListener('input', (e) => {
          e.target.value = e.target.value.replace(/[^0-9]/g, '');
      });

      submitButton.addEventListener('click', () => this.checkPin());

      input.addEventListener('keypress', (e) => {
          if (e.key === 'Enter') {
              this.checkPin();
          }
      });
  }

  checkPin() {
      const input = this.querySelector('#pin-input');
      const errorMessage = this.querySelector('#error-message');

      if (input.value === this.correctPin) {
          this.removeAttribute('active');
          document.getElementById('content').style.display = 'block';
      } else {
          this.attempts++;
          if (this.attempts >= this.maxAttempts) {
              errorMessage.textContent = 'Maximum attempts reached. Please try again later.';
              input.disabled = true;
              this.querySelector('#submit-pin').disabled = true;
          } else {
              errorMessage.textContent = `Incorrect PIN. ${this.maxAttempts - this.attempts} attempts remaining.`;
          }
          input.value = '';
      }
  }
}

//default export PinModal;
customElements.define('pin-modal', PinModal);