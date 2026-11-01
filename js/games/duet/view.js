// PLACEHOLDER — replaced by the real implementation.
import { html } from '../../ui/h.js';
import { GameHeader, ResultActions } from '../../ui/components.js';
import { meta } from './logic.js';
export default function View({ api }) {
  return html`<section class="game"><${GameHeader} meta=${meta} api=${api} /><p>Coming soon.</p><${ResultActions} api=${api} /></section>`;
}
