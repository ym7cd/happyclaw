import { describe, expect, it } from 'vitest';

import {
  normalizeAgentOutputText,
  stripOpenAICitationMarkers,
} from '../src/utils.js';

describe('agent output normalization', () => {
  it('removes raw OpenAI citation markers but keeps正文', () => {
    const input =
      '**Summary**\n\n一句话概括。citeturn19view0turn19view5\n\n第二段。 citeturn10view0';

    expect(stripOpenAICitationMarkers(input)).toBe(
      '**Summary**\n\n一句话概括。\n\n第二段。',
    );
  });

  it('removes internal tags and citation markers together', () => {
    const input =
      '<internal>hidden</internal>可见内容。citeturn21view2\n<process>ignored</process>';

    expect(normalizeAgentOutputText(input)).toBe('可见内容。');
  });
});
