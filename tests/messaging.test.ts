import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isExtensionMessage,
  isExtensionResponse,
  type ExtensionMessage,
  type ExtensionResponse,
} from '../src/shared/messaging/messages';

describe('extension messages', () => {
  it('accepts every supported message type', () => {
    const messages: ExtensionMessage[] = [
      { type: 'PING' },
      { type: 'GET_ACTIVE_PAGE' },
      { type: 'READ_PAGE_CONTEXT' },
      { type: 'CONTENT_READY' },
    ];
    for (const message of messages) assert.equal(isExtensionMessage(message), true);
  });

  it('rejects malformed input and unknown message types', () => {
    for (const message of [
      null, undefined, true, 42, 'PING', [], {},
      { type: null }, { type: 1 }, { type: 'UNKNOWN' },
      { type: 'ADD_TO_QUEUE', payload: { title: 'Unrecognized command' } },
      { type: 'PONG' },
    ]) {
      assert.equal(isExtensionMessage(message), false, JSON.stringify(message));
    }
  });
});

describe('extension responses', () => {
  it('accepts every supported response type', () => {
    const page = { title: 'Звук', origin: 'https://zvuk.com' };
    const responses: ExtensionResponse[] = [
      { type: 'PONG' },
      { type: 'ACK' },
      { type: 'ACTIVE_PAGE', page },
      { type: 'ACTIVE_PAGE', page: null },
      { type: 'PAGE_CONTEXT', page },
      { type: 'ERROR', message: 'No content script on this tab' },
    ];
    for (const response of responses) assert.equal(isExtensionResponse(response), true);
  });

  it('accepts the root origin and nested Zvuk subdomains', () => {
    for (const origin of ['https://zvuk.com', 'https://www.zvuk.com', 'https://music.web.zvuk.com']) {
      assert.equal(isExtensionResponse({ type: 'PAGE_CONTEXT', page: { title: '', origin } }), true);
    }
  });

  it('rejects malformed or missing payloads', () => {
    for (const response of [
      null, undefined, false, 17, 'PONG', [], {}, { type: 'UNKNOWN' },
      { type: 'ACTIVE_PAGE' }, { type: 'PAGE_CONTEXT' },
      { type: 'PAGE_CONTEXT', page: null },
      { type: 'PAGE_CONTEXT', page: {} },
      { type: 'PAGE_CONTEXT', page: { title: 42, origin: 'https://zvuk.com' } },
      { type: 'PAGE_CONTEXT', page: { title: 'Звук', origin: null } },
      { type: 'ACTIVE_PAGE', page: 'https://zvuk.com' },
      { type: 'ERROR' }, { type: 'ERROR', message: 42 },
    ]) {
      assert.equal(isExtensionResponse(response), false, JSON.stringify(response));
    }
  });

  it('rejects spoofed origins, insecure schemes and URLs containing paths', () => {
    const invalidOrigins = [
      'http://zvuk.com',
      'https://evilzvuk.com',
      'https://zvuk.com.attacker.test',
      'https://zvuk.com@attacker.test',
      'https://attacker.test@zvuk.com',
      'https://zvuk.com/path',
      'https://zvuk.com?redirect=attacker.test',
      'https://zvuk.com#fragment',
      'https://zvuk.com:444',
      '//zvuk.com',
      'javascript:https://zvuk.com',
      '',
    ];
    for (const origin of invalidOrigins) {
      const page = { title: 'Untrusted page', origin };
      assert.equal(isExtensionResponse({ type: 'PAGE_CONTEXT', page }), false, origin);
      assert.equal(isExtensionResponse({ type: 'ACTIVE_PAGE', page }), false, origin);
    }
  });
});
