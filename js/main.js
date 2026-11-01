import { html, render } from './ui/h.js';
import { App } from './ui/app.js';
import config from './config.js';

render(html`<${App} config=${config} />`, document.getElementById('app'));
