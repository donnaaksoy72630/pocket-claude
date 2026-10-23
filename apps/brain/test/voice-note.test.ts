import { describe, expect, it } from 'vitest';
import { VOICE_NOTE } from '../src/session.js';

describe('voice note', () => {
  it('asks for a short spoken answer first and puts details after the line the phone stops reading at', () => {
    expect(VOICE_NOTE).toMatch(/one to three short sentences/);
    // apps/mobile/src/voice.ts (oralPart) stops reading aloud at a line of ---.
    expect(VOICE_NOTE).toMatch(/line with only --- on it/);
  });
});
