export function synchronizeByRatio(source: HTMLElement, target: HTMLElement) {
  const maxSource = Math.max(source.scrollHeight - source.clientHeight, 1);
  const ratio = maxSource === 0 ? 0 : source.scrollTop / maxSource;
  target.scrollTop = ratio * Math.max(target.scrollHeight - target.clientHeight, 0);
}
