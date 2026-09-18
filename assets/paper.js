import { initTheme } from "./ui.js";

initTheme();

const copyBtn = document.getElementById("copy-bibtex");
if (copyBtn) {
  copyBtn.addEventListener("click", async () => {
    const text = document.querySelector(".bibtex").textContent;
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = "Copied";
    } catch (e) {
      copyBtn.textContent = "Select and copy manually";
    }
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
  });
}
