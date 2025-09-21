class PinModal extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this.shadowRoot.innerHTML = `
        <style>
:root{--overlay-bg:rgba(0, 0, 0, 0.8);--overlay-color:white;--button-bg:#007bff;--button-hover-bg:#0056b3;--font-family:Arial, sans-serif}body{margin:0;font-family:var(--font-family)}.overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:var(--overlay-bg);color:var(--overlay-color);display:flex;justify-content:center;align-items:center;z-index:1000}.overlay-content{text-align:center;background:#222;padding:20px;border-radius:10px;box-shadow:0 4px 10px rgb(0 0 0 / .5)}.overlay-content h2{margin-bottom:20px}.overlay-content input{width:100px;padding:10px;font-size:18px;text-align:center;margin-bottom:20px}.overlay-content button{padding:10px 20px;font-size:16px;background:var(--button-bg);color:#fff;border:none;border-radius:5px;cursor:pointer}.overlay-content button:hover{background:var(--button-hover-bg)}

        </style>
            <div class="overlay">
                <div class="overlay-content">
                    <h2>Enter PIN</h2>
                    <input type="password" maxlength="6" placeholder="6-digit PIN" />
                    <button>Submit</button>
                </div>
            </div>
        `;
        this.correctPin = '123456'; // Replace with your desired PIN
    }

    connectedCallback() {
        this.shadowRoot.querySelector('button').addEventListener('click', this.validatePin.bind(this));
    }

    disconnectedCallback() {
        this.shadowRoot.querySelector('button').removeEventListener('click', this.validatePin);
    }

    validatePin() {
        const input = this.shadowRoot.querySelector('input').value;
        if (input === this.correctPin) {
            this.removeOverlay();
        } else {
            alert('Incorrect PIN!');
        }
    }

    removeOverlay() {
        this.remove();
    }
}

//customElements.define('pin-modal', PinModal);

export default PinModal;
//customElements.define('pin-modal', PinModal);