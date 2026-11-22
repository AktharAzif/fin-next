// The fixture app the harness serves in its own tests: a page that is ready once its script runs,
// calls its API half on request, and breaks the page policy only when a test asks it to.
const main = document.getElementById("main");

async function ping() {
  const response = await fetch("/api/ping", {
    method: "POST",
    headers: { "content-type": "application/json", "x-fin-app": "fixture" },
    body: JSON.stringify({ from: "page" }),
  });
  const answer = await response.json();
  main.textContent = `API ${response.status} ${answer.host}`;
}

if (location.hash === "#ping") {
  await ping();
}

if (location.hash === "#violate-style") {
  // An inline style attribute, which `style-src 'self'` refuses.
  main.setAttribute("style", "color: red");
}

if (location.hash === "#violate-script") {
  // A script from another origin, which `script-src 'self'` refuses before any request leaves.
  const script = document.createElement("script");
  script.src = "https://script.example.invalid/x.js";
  document.head.append(script);
}

document.body.dataset.ready = "";
