// Access gate handling
const accessGate = document.getElementById('accessGate');
const mainApp = document.getElementById('mainApp');
const accessForm = document.getElementById('accessForm');
const accessCodeInput = document.getElementById('accessCode');
const accessAlert = document.getElementById('accessAlert');
const accessBtn = document.getElementById('accessBtn');
const accessLoading = document.getElementById('accessLoading');

const ACCESS_KEY = 'translation_beta_access';

function showAccessAlert(message, type) {
  accessAlert.className = `alert alert-${type} visible`;
  accessAlert.textContent = message;
}

function hideAccessAlert() {
  accessAlert.className = 'alert';
}

function checkAccess() {
  const hasAccess = localStorage.getItem(ACCESS_KEY);
  if (hasAccess === 'granted') {
    accessGate.style.display = 'none';
    mainApp.style.display = 'block';
    return true;
  }
  return false;
}

// Check access on page load
checkAccess();

// Handle access form submission
accessForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const code = accessCodeInput.value.trim();

  if (!code) {
    showAccessAlert('Please enter an access code', 'error');
    return;
  }

  // Disable form and show loading
  accessBtn.disabled = true;
  accessBtn.style.display = 'none';
  accessLoading.classList.add('visible');
  hideAccessAlert();

  try {
    const response = await fetch('/api/verify-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });

    const data = await response.json();

    if (data.valid) {
      localStorage.setItem(ACCESS_KEY, 'granted');
      accessGate.style.display = 'none';
      mainApp.style.display = 'block';
    } else {
      showAccessAlert('Invalid access code. Please try again.', 'error');
    }
  } catch (error) {
    showAccessAlert('Failed to verify access code. Please try again.', 'error');
  } finally {
    accessBtn.disabled = false;
    accessBtn.style.display = 'block';
    accessLoading.classList.remove('visible');
  }
});

// Upload form handling
const uploadForm = document.getElementById('uploadForm');
const fileUpload = document.getElementById('fileUpload');
const fileInput = document.getElementById('document');
const fileName = document.getElementById('fileName');
const alert = document.getElementById('alert');
const submitBtn = document.getElementById('submitBtn');
const loading = document.getElementById('loading');

// File upload drag and drop
fileUpload.addEventListener('click', () => fileInput.click());

fileUpload.addEventListener('dragover', (e) => {
  e.preventDefault();
  fileUpload.classList.add('drag-over');
});

fileUpload.addEventListener('dragleave', () => {
  fileUpload.classList.remove('drag-over');
});

fileUpload.addEventListener('drop', (e) => {
  e.preventDefault();
  fileUpload.classList.remove('drag-over');

  const files = e.dataTransfer.files;
  if (files.length > 0) {
    handleFile(files[0]);
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    handleFile(e.target.files[0]);
  }
});

function handleFile(file) {
  // Validate file type
  if (file.type !== 'application/pdf') {
    showAlert('Please select a PDF file', 'error');
    return;
  }

  // Validate file size (10MB)
  if (file.size > 10 * 1024 * 1024) {
    showAlert('File size must be less than 10MB', 'error');
    return;
  }

  // Update UI
  fileName.textContent = `${file.name} (${formatFileSize(file.size)})`;
  fileName.classList.add('visible');
  fileUpload.classList.add('has-file');

  // Create new FileList for input
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  fileInput.files = dataTransfer.files;

  hideAlert();
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function showAlert(message, type) {
  alert.className = `alert alert-${type} visible`;
  alert.textContent = message;
}

function hideAlert() {
  alert.className = 'alert';
}

// Form submission
uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const email = document.getElementById('email').value;
  const sourceLanguage = document.getElementById('sourceLanguage').value;
  const file = fileInput.files[0];

  if (!email) {
    showAlert('Please enter your email address', 'error');
    return;
  }

  if (!file) {
    showAlert('Please select a PDF file to upload', 'error');
    return;
  }

  // Disable form and show loading
  submitBtn.disabled = true;
  submitBtn.style.display = 'none';
  loading.classList.add('visible');
  hideAlert();

  const formData = new FormData();
  formData.append('email', email);
  formData.append('sourceLanguage', sourceLanguage);
  formData.append('document', file);

  try {
    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Upload failed');
    }

    // Success
    showAlert(`Document uploaded successfully! Please check your email (${email}) for the quote.`, 'success');

    // Reset form
    uploadForm.reset();
    fileName.classList.remove('visible');
    fileUpload.classList.remove('has-file');
  } catch (error) {
    showAlert(error.message || 'Failed to upload document. Please try again.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.style.display = 'block';
    loading.classList.remove('visible');
  }
});