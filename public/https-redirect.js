// Upgrades plain-HTTP visits before the wallet starts. A separate file keeps
// the page CSP at script-src 'self' (inline scripts are blocked).
if (
  window.location.protocol === "http:" &&
  window.location.hostname !== "localhost" &&
  window.location.hostname !== "127.0.0.1"
) {
  window.location.replace(`https://${window.location.host}${window.location.pathname}${window.location.search}${window.location.hash}`);
}
