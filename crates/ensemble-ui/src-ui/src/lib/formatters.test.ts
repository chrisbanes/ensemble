import { describe, it, expect } from 'vitest';
import { formatDuration, formatTokens } from './formatters';

describe('formatDuration', () => {
  it('formats seconds', () => {
    const result = formatDuration(new Date(Date.now() - 45000).toISOString());
    expect(result).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    const result = formatDuration(new Date(Date.now() - 150000).toISOString());
    expect(result).toBe('2m 30s');
  });

  it('formats hours and minutes', () => {
    const result = formatDuration(new Date(Date.now() - 4500000).toISOString());
    expect(result).toMatch(/1h \d+m/);
  });

  it('handles future dates', () => {
    const futureDate = new Date(Date.now() + 10000).toISOString();
    expect(formatDuration(futureDate)).toBe('0s');
  });

  it('handles zero duration', () => {
    const result = formatDuration(new Date(Date.now()).toISOString());
    expect(result).toBe('0s');
  });
});

describe('formatTokens', () => {
  it('formats small numbers', () => {
    expect(formatTokens(500)).toBe('500');
  });

  it('formats thousands with k', () => {
    expect(formatTokens(1200)).toBe('1.2k');
  });

  it('formats millions with M', () => {
    expect(formatTokens(1500000)).toBe('1.5M');
  });

  it('formats zero', () => {
    expect(formatTokens(0)).toBe('0');
  });

  it('formats exact thousand boundary', () => {
    expect(formatTokens(1000)).toBe('1.0k');
  });

  it('handles negative numbers', () => {
    expect(formatTokens(-100)).toBe('0');
  });
});
