import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We'll mock isProductPage to control detection timing

describe('content script log-once behavior', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('logs once when detection flips true on the delayed pass', async () => {
    // Arrange: readyState as 'loading' so the module attaches DOMContentLoaded handler
    Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });

    let calls = 0;
    vi.mock('../src/detect', () => ({
      isProductPage: vi.fn(() => {
        calls += 1;
        return calls === 2; // false on first (DOMContentLoaded), true on second (after 500ms)
      })
    }));

    // Import after mocks
    await import('../src/content');

    // Fire DOMContentLoaded
    document.dispatchEvent(new Event('DOMContentLoaded'));

    // Advance 500ms to trigger the delayed pass
    await vi.advanceTimersByTimeAsync(500);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('Product Detected');
  });

  it('logs only once even if detection is true on both passes', async () => {
    Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });

    vi.mock('../src/detect', () => ({
      isProductPage: vi.fn(() => true)
    }));

    await import('../src/content');

    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(500);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('Product Detected');
  });
});
