import { describe, expect, it } from 'vitest';
import { errnoOf, LINUX_ERRNO, rustIoErrorText, strerror } from '../../src/abi/errno.ts';
import { hostError } from '../../src/ports/result.ts';

describe('errno', () => {
  it('prints Rust io::Error text for common failures', () => {
    expect(rustIoErrorText(hostError('ENOENT'))).toBe('No such file or directory (os error 2)');
    expect(rustIoErrorText(hostError('EACCES'))).toBe('Permission denied (os error 13)');
    expect(rustIoErrorText(hostError('EISDIR'))).toBe('Is a directory (os error 21)');
    expect(rustIoErrorText(hostError('ENOTDIR'))).toBe('Not a directory (os error 20)');
    expect(rustIoErrorText(hostError('EEXIST'))).toBe('File exists (os error 17)');
  });

  it('has a distinct number and a text for every code', () => {
    const numbers = Object.values(LINUX_ERRNO);
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const code of Object.keys(LINUX_ERRNO)) {
      expect(strerror(code)).not.toBe('');
    }
  });

  it('reads unknown codes as EIO', () => {
    expect(errnoOf('ERR_INVALID_ARG_VALUE')).toBe(5);
    expect(strerror('ERR_INVALID_ARG_VALUE')).toBe('Input/output error');
  });
});
