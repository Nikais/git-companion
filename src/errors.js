export class GitError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
