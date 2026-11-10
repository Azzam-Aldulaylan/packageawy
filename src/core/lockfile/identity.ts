/** Separate npm alias registry identity from its installed dependency key. */
export function npmAlias(spec: string): { name: string; range: string } | null {
  if (!spec.startsWith('npm:')) return null;
  const target = spec.slice(4);
  const separator = target.lastIndexOf('@');
  const name = separator > 0 ? target.slice(0, separator) : target;
  if (name === '') return null;
  return { name, range: separator > 0 ? target.slice(separator + 1) : '*' };
}
