export function isCodexBusinessConfigured(): boolean {
  return !!process.env.CODEX_ACCESS_TOKEN?.trim()
}

export function getCodexBusinessStatus(): { configured: boolean; binary: string } {
  return {
    configured: isCodexBusinessConfigured(),
    binary: process.env.ADMIRAL_CODEX_BIN?.trim() || 'codex',
  }
}
