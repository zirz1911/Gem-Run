const status = document.querySelector("#status");

fetch("/api/health")
  .then((response) => response.json())
  .then(({app}) => {
    status.textContent = app === "ok" ? "Service is ready." : "Service is unavailable.";
  })
  .catch(() => {
    status.textContent = "Service is unavailable.";
  });
