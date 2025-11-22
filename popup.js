// 1. 初始化 Worker (确保路径正确)
if (typeof pdfjsLib === 'undefined') {
  console.error("PDF.js library not loaded!");
} else {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
}

// 2. 获取 DOM 元素
const fileInput = document.getElementById('fileInput');
const fileNameDisplay = document.getElementById('fileName');
const settingsArea = document.getElementById('settingsArea');
const statusArea = document.getElementById('statusArea');
const startBtn = document.getElementById('startBtn');
const downloadBtn = document.getElementById('downloadBtn');
const progressBar = document.getElementById('progressBar');
const statusText = document.getElementById('statusText');

// 设置项元素
const formatSelect = document.getElementById('formatSelect');
const scaleSlider = document.getElementById('scaleSlider');
const scaleValueDisplay = document.getElementById('scaleValue');
const pageCountDisplay = document.getElementById('pageCount');
const estDimensionsDisplay = document.getElementById('estDimensions');
const estSizeDisplay = document.getElementById('estSize');

// 3. 全局变量存储当前 PDF 信息
let currentPDF = null;
let currentFile = null;
let basePageWidth = 0;
let basePageHeight = 0;
let finalBlobUrl = null;

// --- 事件监听 ---

// 文件选择
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  if (file.type !== 'application/pdf') {
    alert("请上传 PDF 文件");
    return;
  }

  currentFile = file;
  fileNameDisplay.innerText = file.name;
  
  // 重置界面
  settingsArea.style.display = 'none';
  statusArea.style.display = 'none';
  downloadBtn.style.display = 'none';
  
  // 预加载 PDF 获取信息
  await loadPDFInfo(file);
});

// 滑动条变化
scaleSlider.addEventListener('input', (e) => {
  scaleValueDisplay.innerText = e.target.value;
  updateEstimate();
});

// 格式选择变化
formatSelect.addEventListener('change', () => {
  updateEstimate();
});

// 点击开始转换
startBtn.addEventListener('click', async () => {
  if (!currentPDF) return;
  
  settingsArea.style.display = 'none'; // 转换时隐藏设置
  statusArea.style.display = 'block';
  startBtn.disabled = true;
  
  try {
    await generateLongImage();
  } catch (err) {
    console.error(err);
    statusText.innerText = "错误: " + err.message;
    startBtn.disabled = false;
    settingsArea.style.display = 'block'; // 失败则重新显示设置
  }
});

// 点击下载
downloadBtn.addEventListener('click', () => {
  if (finalBlobUrl) {
    const format = formatSelect.value;
    const ext = format === 'jpeg' ? 'jpg' : 'png';
    const a = document.createElement('a');
    a.href = finalBlobUrl;
    a.download = `long_image_${Date.now()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
});


// --- 核心功能函数 ---

// 读取文件为 ArrayBuffer
function readFileAsync(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

// 第一步：加载 PDF 并获取元数据
async function loadPDFInfo(file) {
  try {
    const data = await readFileAsync(file);
    const loadingTask = pdfjsLib.getDocument(data);
    currentPDF = await loadingTask.promise;

    // 获取第一页尺寸作为基准
    const page1 = await currentPDF.getPage(1);
    const viewport = page1.getViewport({ scale: 1 });
    basePageWidth = viewport.width;
    basePageHeight = viewport.height;

    // 更新 UI 显示
    pageCountDisplay.innerText = currentPDF.numPages;
    settingsArea.style.display = 'block'; // 显示设置区
    updateEstimate(); // 计算初始预估值

  } catch (err) {
    console.error(err);
    fileNameDisplay.innerText = "文件解析失败";
  }
}

// 更新预估尺寸和体积
function updateEstimate() {
  if (!currentPDF) return;

  const scale = parseFloat(scaleSlider.value);
  const numPages = currentPDF.numPages;
  const format = formatSelect.value;

  // 预估总尺寸
  const totalW = Math.round(basePageWidth * scale);
  const totalH = Math.round(basePageHeight * scale * numPages);
  
  estDimensionsDisplay.innerText = `${totalW} x ${totalH}`;

  // 预估体积 (粗略算法)
  // 像素总数
  const totalPixels = totalW * totalH;
  // 原始 RGBA 大小 (MB)
  const rawSizeMB = (totalPixels * 4) / (1024 * 1024);
  
  // 压缩比估算: PNG~0.3, JPEG~0.05 (非常粗略)
  let estSizeMB = 0;
  if (format === 'png') {
    estSizeMB = rawSizeMB * 0.3; 
  } else {
    estSizeMB = rawSizeMB * 0.05;
  }

  // 格式化显示
  let sizeText = estSizeMB.toFixed(1) + " MB";
  
  // 警告：如果超过浏览器 Canvas 限制 (通常限制在高度 32767px 或总面积 268MP)
  if (totalH > 30000 || totalPixels > 200000000) {
    estDimensionsDisplay.style.color = "red";
    sizeText += " (可能过大)";
  } else {
    estDimensionsDisplay.style.color = "#555";
  }
  
  estSizeDisplay.innerText = `~${sizeText}`;
}

// 第二步：生成长图
async function generateLongImage() {
  const scale = parseFloat(scaleSlider.value);
  const format = formatSelect.value; // 'png' or 'jpeg'
  const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const quality = format === 'jpeg' ? 0.8 : 1.0; // JPEG 质量 0.8

  const numPages = currentPDF.numPages;
  const canvasList = [];
  let totalHeight = 0;
  let maxWidth = 0;

  // 1. 渲染每一页
  for (let i = 1; i <= numPages; i++) {
    statusText.innerText = `正在渲染第 ${i} / ${numPages} 页...`;
    progressBar.style.width = `${(i / numPages) * 80}%`;

    const page = await currentPDF.getPage(i);
    const viewport = page.getViewport({ scale: scale });
    
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({
      canvasContext: context,
      viewport: viewport
    }).promise;

    canvasList.push(canvas);
    totalHeight += viewport.height;
    if (viewport.width > maxWidth) maxWidth = viewport.width;
  }

  // 2. 拼接
  statusText.innerText = "正在拼接...";
  progressBar.style.width = "90%";

  const finalCanvas = document.createElement('canvas');
  finalCanvas.width = maxWidth;
  finalCanvas.height = totalHeight;
  const ctx = finalCanvas.getContext('2d');

  // 填充白色背景 (特别是 JPEG 需要，因为不支持透明)
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);

  let currentY = 0;
  for (const cvs of canvasList) {
    const x = (maxWidth - cvs.width) / 2;
    ctx.drawImage(cvs, x, currentY);
    currentY += cvs.height;
  }

  // 3. 导出
  statusText.innerText = "正在生成文件...";
  progressBar.style.width = "100%";

  // 使用 toBlob 替代 toDataURL 以支持更大的文件
  finalCanvas.toBlob((blob) => {
    if (blob) {
      if (finalBlobUrl) URL.revokeObjectURL(finalBlobUrl); // 释放旧内存
      finalBlobUrl = URL.createObjectURL(blob);
      
      downloadBtn.style.display = 'block';
      downloadBtn.innerText = `下载 ${format.toUpperCase()} (${(blob.size/1024/1024).toFixed(2)}MB)`;
      statusText.innerText = "转换完成！";
      startBtn.disabled = false; // 允许再次转换
      settingsArea.style.display = 'block';
    } else {
      statusText.innerText = "生成失败：可能是图片尺寸超出浏览器限制";
      startBtn.disabled = false;
    }
  }, mimeType, quality);
}