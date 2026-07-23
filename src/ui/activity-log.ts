export interface ActivityDetail {
  label: string;
  value: string;
  title?: string;
}

export interface ActivityEntry {
  at: number;
  label: string;
  title: string;
  details?: ActivityDetail[];
}

function element<K extends keyof HTMLElementTagNameMap>(
  name: K,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderActivityLog(
  root: HTMLOListElement,
  entries: readonly ActivityEntry[]
): void {
  root.replaceChildren();
  for (const entry of entries) {
    const item = element("li");
    item.dataset.activityLabel = entry.label.toLowerCase().replace(/\s+/g, "-");
    const time = element("time", new Date(entry.at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }));
    time.dateTime = new Date(entry.at).toISOString();

    const body = element("div");
    body.className = "activity-entry";
    const heading = element("div");
    heading.className = "activity-entry__heading";
    heading.append(element("span", entry.label), element("strong", entry.title));
    body.append(heading);

    if (entry.details && entry.details.length > 0) {
      const details = element("dl");
      for (const detail of entry.details) {
        const term = element("dt", detail.label);
        const value = element("dd", detail.value);
        if (detail.title !== undefined) value.title = detail.title;
        details.append(term, value);
      }
      body.append(details);
    }
    item.append(time, body);
    root.append(item);
  }
}
