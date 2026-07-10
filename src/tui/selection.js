export function reduceHistorySelection(state = {}, event = {}, rowCount = 0) {
  const count = Math.max(0, Math.floor(Number(rowCount) || 0));
  const selectedIndex = Math.min(
    Math.max(0, Math.floor(Number(state.selectedIndex) || 0)),
    Math.max(0, count - 1),
  );
  const detailOpen = Boolean(state.detailOpen) && count > 0;

  switch (event.type) {
    case "up":
      return { selectedIndex: Math.max(0, selectedIndex - 1), detailOpen };
    case "down":
      return { selectedIndex: Math.min(Math.max(0, count - 1), selectedIndex + 1), detailOpen };
    case "top":
      return { selectedIndex: 0, detailOpen };
    case "bottom":
      return { selectedIndex: Math.max(0, count - 1), detailOpen };
    case "enter":
      return { selectedIndex, detailOpen: count > 0 };
    case "esc":
    case "left":
    case "back":
      return { selectedIndex, detailOpen: false };
    default:
      return { selectedIndex, detailOpen };
  }
}
