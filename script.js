const copyButton = document.getElementById('copy-subscription');
const subscriptionUrl = document.getElementById('sub-url');

async function copySubscription() {
  const text = subscriptionUrl.innerText.trim();

  try {
    await navigator.clipboard.writeText(text);
    copyButton.innerText = 'Copied!';
    copyButton.classList.add('copied');
  } catch (error) {
    alert('Không thể sao chép tự động, vui lòng chọn text và copy thủ công.');
    return;
  }

  setTimeout(() => {
    copyButton.innerText = 'Copy URL';
    copyButton.classList.remove('copied');
  }, 2000);
}

copyButton.addEventListener('click', copySubscription);
