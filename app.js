import { WebUsbTransport, FastbootDriver, flashAll, update, ZipImageSource, waitForReconnect, findFastbootInterface, FASTBOOT_USB_FILTERS, requestFastbootDevice } from './webfastboot/src/index.js';
import { AdbWebUsbTransport, Adb, ADB_DEVICE_FILTERS, isAdbInterface } from './webadb/src/index.js';

let currentDriver = null;
let currentConnectedDevice = null;
let selectedBuild = null;
let fetchedBuilds = [];

const splashView = document.getElementById('splash-view');
const buildView = document.getElementById('build-view');
const noDevicePanel = document.getElementById('no-device-panel');
const deviceConnectedPanel = document.getElementById('device-connected-panel');
const findBuildEmpty = document.getElementById('find-build-empty');
const findBuildConnected = document.getElementById('find-build-connected');
const buildSelectedPanel = document.getElementById('build-selected-panel');
const confirmModal = document.getElementById('confirm-modal');
const cardTitle = document.getElementById('card-title');
const headIconSteps = Array.from(document.querySelectorAll('#head-icons .head-icon'));
const HEAD_ICON_ORDER = ['device', 'build', 'flash'];

// Marks every step before `activeStep` as done (checkmark badge), the
// step itself as in-progress (filled circle), and leaves later steps
// as plain/pending icons.
function setHeadIconStep(activeStep) {
  const activeIndex = HEAD_ICON_ORDER.indexOf(activeStep);
  headIconSteps.forEach((el) => {
    const stepIndex = HEAD_ICON_ORDER.indexOf(el.dataset.step);
    el.classList.toggle('is-done', stepIndex < activeIndex);
    el.classList.toggle('is-active', stepIndex === activeIndex);
  });
}

document.getElementById('get-started-btn').addEventListener('click', () => {
  splashView.hidden = true;
  buildView.hidden = false;
});

// Info dialogs (shared open / close / Esc / backdrop behaviour)
function setupDialog(modalId, closeBtnId) {
  const modal = document.getElementById(modalId);
  const closeBtn = document.getElementById(closeBtnId);
  let opener = null;

  function open(el) {
    opener = el || null;
    modal.hidden = false;
    closeBtn.focus();
  }
  function close() {
    modal.hidden = true;
    if (opener) opener.focus();
  }

  closeBtn.addEventListener('click', close);
  // Click on the dimmed backdrop (but not the card itself) also closes it.
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) close();
  });
  return { open, close };
}

// Every element matching `selector` opens `dialog`.
function bindOpeners(selector, dialog) {
  document.querySelectorAll(selector).forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      dialog.open(el);
    });
  });
}

// Troubleshooting dialog: the inline "troubleshooting tips" text and the bottom link.
const troubleshootDialog = setupDialog('troubleshoot-modal', 'troubleshoot-close');
bindOpeners('.js-troubleshoot', troubleshootDialog);

// "Enable Developer Options" dialog: Step 1's "Follow these steps" link.
const devOptionsDialog = setupDialog('dev-options-modal', 'dev-options-close');
bindOpeners('.js-dev-options', devOptionsDialog);

// Placeholder doc links: don't jump to the top of the page.
['prepared-device-link', 'oem-instructions-link'].forEach((id) => {
  document.getElementById(id).addEventListener('click', (e) => e.preventDefault());
});

document.getElementById('add-device-btn').addEventListener('click', async () => {
  try {
    await connectDevice();
  } catch (err) {
    console.error('Device connection error:', err);
    alert('Could not connect to device: ' + (err.message || err));
  }
});

/** True if any interface/alternate on this (already-selected) device is an ADB interface. */
function hasAdbInterface(device) {
  for (const configuration of device.configurations) {
    for (const iface of configuration.interfaces) {
      for (const alternate of iface.alternates) {
        if (isAdbInterface(alternate.interfaceClass, alternate.interfaceSubclass,
                            alternate.interfaceProtocol)) {
          return true;
        }
      }
    }
  }
  return false;
}

async function connectDevice() {
  if (!navigator.usb) throw new Error('WebUSB is not available in this browser');

  // Single chooser matching either an ADB interface (booted Android OS) or
  // a Fastboot interface (bootloader/fastbootd), so a device already sitting
  // in fastboot mode shows up in the same dialog as one booted with ADB
  // enabled, rather than only being found on a second, separate prompt.
  const device = await navigator.usb.requestDevice({
    filters: [...ADB_DEVICE_FILTERS, ...FASTBOOT_USB_FILTERS],
  });

  if (findFastbootInterface(device)) {
    console.log('Connected over Fastboot');
    const transport = new WebUsbTransport(device);
    await transport.open();
    currentDriver = new FastbootDriver(transport);

    let product = 'tangorpro';
    let serial = device.serialNumber || 'UNKNOWN_SERIAL';
    let buildId = 'TD2A.230203.028';

    try { product = (await currentDriver.getVar('product')) || product; } catch (e) {}
    try { serial = (await currentDriver.getVar('serialno')) || serial; } catch (e) {}
    try { buildId = (await currentDriver.getVar('version-baseband')) || (await currentDriver.getVar('version-bootloader')) || buildId; } catch (e) {}

    currentConnectedDevice = {
      mode: 'fastboot',
      product: product,
      serial: serial,
      buildId: buildId,
      arch: (product.includes('arm64') || product === 'tangorpro') ? 'arm64' : 'x86_64'
    };
    showConnectedDevice(currentConnectedDevice);
    await loadAvailableBuilds(currentConnectedDevice.product, currentConnectedDevice.arch);
    return;
  }

  if (hasAdbInterface(device)) {
    console.log('Connected over ADB');
    const adb = await Adb.connect({ device });

    let product = 'tangorpro';
    let serial = device.serialNumber || 'UNKNOWN_SERIAL';
    try { product = (await adb.shell('getprop ro.product.device')).trim() || product; } catch (e) {}

    currentConnectedDevice = {
      mode: 'adb',
      adbInstance: adb,
      rawDevice: device,
      product: product,
      serial: serial,
      buildId: 'ADB Mode Device',
      arch: (product.includes('arm64') || product === 'tangorpro') ? 'arm64' : 'x86_64'
    };
    showConnectedDevice(currentConnectedDevice);
    await loadAvailableBuilds(currentConnectedDevice.product, currentConnectedDevice.arch);
    return;
  }

  throw new Error('Selected device exposes neither an ADB nor a Fastboot interface');
}

function showConnectedDevice(dev) {
  noDevicePanel.hidden = true;
  deviceConnectedPanel.hidden = false;
  findBuildEmpty.hidden = true;
  findBuildConnected.hidden = false;
  setHeadIconStep('build');
  resetDisconnectUi();

  const deviceNameEl = deviceConnectedPanel.querySelector('.device-name');
  const deviceMetaEl = deviceConnectedPanel.querySelector('.device-meta');

  const displayName = dev.product === 'tangorpro' ? 'Pixel Tablet (tangorpro)' : dev.product;
  deviceNameEl.textContent = `${displayName} [${dev.mode.toUpperCase()}]`;
  deviceMetaEl.innerHTML = `
    ${dev.serial} <span class="material-symbols-outlined copy-icon">content_copy</span>
    <span class="meta-sep">|</span>
    ${dev.buildId} <span class="material-symbols-outlined copy-icon">content_copy</span>
  `;
}

// --- Device-lost handling for the "selected build" screen ---
// Once a device is connected we watch for it unplugging while the user is
// sitting on the build-selected screen (i.e. before "Install build" has
// been clicked). The in-flight install flow has its own disconnect
// handling once flashing has actually started, so this only acts when
// install-progress isn't showing.
const deviceStatusChip = document.getElementById('device-status-chip');
const disconnectedBanner = document.getElementById('device-disconnected-banner');
const installBuildBtn = document.getElementById('install-build-btn');
const installProgress = document.getElementById('install-progress');

function getConnectedRawDevice() {
  if (!currentConnectedDevice) return null;
  if (currentConnectedDevice.mode === 'adb') {
    return currentConnectedDevice.rawDevice
      || currentConnectedDevice.adbInstance?.connection?.transport?.device
      || null;
  }
  return currentDriver?.transport?.device || null;
}

function resetDisconnectUi() {
  deviceStatusChip.classList.remove('is-disconnected');
  deviceStatusChip.innerHTML = '<span class="material-symbols-outlined">warning</span> Connected (slow)';
  disconnectedBanner.hidden = true;
  installBuildBtn.disabled = false;
}

navigator.usb?.addEventListener('disconnect', (event) => {
  const liveDevice = getConnectedRawDevice();
  if (!liveDevice || event.device !== liveDevice) return;
  if (!installProgress.hidden) return; // handled by the in-flight install listener instead

  deviceStatusChip.classList.add('is-disconnected');
  deviceStatusChip.innerHTML = '<span class="material-symbols-outlined">link_off</span> Disconnected';

  if (!buildSelectedPanel.hidden) {
    disconnectedBanner.hidden = false;
    installBuildBtn.disabled = true;
  }
});

// If the same device comes back while we're still on the build-selected
// screen, restore the normal state. (Matched by serial number, since the
// USB device object itself is a new instance after re-enumeration.)
navigator.usb?.addEventListener('connect', (event) => {
  if (!currentConnectedDevice || !deviceStatusChip.classList.contains('is-disconnected')) return;
  if (event.device.serialNumber !== currentConnectedDevice.serial) return;
  resetDisconnectUi();
});

async function loadAvailableBuilds(board, arch) {
  try {
    const res = await fetch(`/api/builds?board=${encodeURIComponent(board)}&arch=${encodeURIComponent(arch)}`);
    const data = await res.json();
    fetchedBuilds = data.compatibleBuilds || [];
    renderBuildList(fetchedBuilds, board);
  } catch (err) {
    console.error('Failed to fetch builds from backend:', err);
  }
}

function renderBuildList(builds, board) {
  const container = findBuildConnected;
  const recTitle = container.querySelector('.field-label[style*="margin-top:22px"]');
  if (recTitle) recTitle.textContent = `Recommended builds for ${board}`;

  // Remove existing dynamic branch-groups
  container.querySelectorAll('.branch-group, .more-releases').forEach(el => el.remove());

  const gsiBuilds = builds.filter(b => b.isGSI === true || b.isGSI === "true");
  const nativeBuilds = builds.filter(b => !(b.isGSI === true || b.isGSI === "true"));

  // Native builds section
  if (nativeBuilds.length > 0) {
    const group = document.createElement('div');
    group.className = 'branch-group';
    group.innerHTML = `<p class="branch-title">Official Factory Images (${board}) <span class="material-symbols-outlined">expand_less</span></p>`;
    nativeBuilds.forEach(b => {
      const chip = document.createElement('a');
      chip.className = 'build-chip build-chip-wide';
      chip.href = '#';
      chip.innerHTML = `
        ${b.releaseCandidateName} (${b.buildId})
        <span class="build-chip-sub">${b.versionName || b.target} &bull; ${b.releaseBuildMetadata?.notes || 'Factory Image'}</span>
      `;
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        selectBuild(b);
      });
      group.appendChild(chip);
    });
    container.appendChild(group);
  }

  // GSI builds section
  if (gsiBuilds.length > 0) {
    const group = document.createElement('div');
    group.className = 'branch-group';
    group.innerHTML = `<p class="branch-title">Generic System Images (GSIs) <span class="material-symbols-outlined">expand_less</span></p>`;
    gsiBuilds.forEach(b => {
      const chip = document.createElement('a');
      chip.className = 'build-chip build-chip-wide';
      chip.href = '#';
      chip.innerHTML = `
        ${b.releaseCandidateName} (${b.buildId})
        <span class="build-chip-sub">${b.versionName || b.target} &bull; Compatible GSI</span>
      `;
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        selectBuild(b);
      });
      group.appendChild(chip);
    });
    container.appendChild(group);
  }
}

const buildSummaryView = document.getElementById('build-summary-view');
const buildOptionsView = document.getElementById('build-options-view');
const targetSelect = document.getElementById('target-select');
const advancedOptions = document.getElementById('advanced-options');
const advancedToggleIcon = document.getElementById('advanced-toggle-icon');

function selectBuild(build) {
  selectedBuild = build;
  findBuildConnected.hidden = true;
  buildSelectedPanel.hidden = false;
  cardTitle.textContent = 'Installing build';
  setHeadIconStep('flash');

  const buildNameEl = buildSelectedPanel.querySelector('.build-name');
  const buildMetaEl = buildSelectedPanel.querySelector('.build-meta');

  buildNameEl.textContent = `${build.releaseCandidateName} (${build.buildId})`;
  buildMetaEl.innerHTML = `${build.target} <span class="meta-sep">|</span> ${build.versionName || build.version} <span class="meta-sep">|</span> API level ${build.apiLevel || 33}`;

  // Reset the flash-options editor for this build: back to the collapsed
  // summary view, target dropdown pointed at this build's only known
  // target, and checkboxes back to their defaults (Wipe Device + Force
  // Flash all Partitions on, everything else off).
  buildOptionsView.hidden = true;
  buildSummaryView.hidden = false;
  document.getElementById('options-build-name').textContent = `${build.releaseCandidateName} (${build.buildId})`;
  targetSelect.innerHTML = '';
  const targetOption = document.createElement('option');
  targetOption.value = build.target;
  targetOption.textContent = build.target;
  targetSelect.appendChild(targetOption);
  document.getElementById('opt-wipe').checked = true;
  document.getElementById('opt-lock').checked = false;
  document.getElementById('opt-force').checked = true;
  document.getElementById('opt-disable-verity').checked = false;
  document.getElementById('opt-disable-verification').checked = false;
  document.getElementById('opt-skip-secondary').checked = false;
  advancedOptions.hidden = false;
  advancedToggleIcon.textContent = 'expand_less';

  // Update Modal
  const modalRows = confirmModal.querySelectorAll('.modal-row');
  if (modalRows[0]) {
    modalRows[0].querySelector('.modal-row-title').textContent = currentConnectedDevice ? `${currentConnectedDevice.product} (${currentConnectedDevice.mode})` : 'Connected Device';
    modalRows[0].querySelector('.modal-row-sub').textContent = currentConnectedDevice ? currentConnectedDevice.serial : '';
  }
  if (modalRows[1]) {
    modalRows[1].querySelector('.modal-row-title').textContent = `${build.releaseCandidateName} (${build.buildId})`;
    modalRows[1].querySelector('.modal-row-sub').textContent = `${build.target} | ${build.versionName || build.version} | API level ${build.apiLevel || 33}`;
  }
}

document.getElementById('edit-options-btn').addEventListener('click', () => {
  buildSummaryView.hidden = true;
  buildOptionsView.hidden = false;
});

document.getElementById('advanced-toggle').addEventListener('click', (e) => {
  e.preventDefault();
  advancedOptions.hidden = !advancedOptions.hidden;
  advancedToggleIcon.textContent = advancedOptions.hidden ? 'expand_more' : 'expand_less';
});

document.getElementById('pick-different-build').addEventListener('click', (e) => {
  e.preventDefault();
  buildSelectedPanel.hidden = true;
  findBuildConnected.hidden = false;
  cardTitle.textContent = 'Select a build';
  setHeadIconStep('build');
});

document.getElementById('install-build-btn').addEventListener('click', () => {
  confirmModal.hidden = false;
});

document.getElementById('confirm-cancel').addEventListener('click', () => {
  confirmModal.hidden = true;
});

const installSteps = [
  { title: 'Preparing your device', active: 'Rebooting into bootloader fastboot mode…', done: 'Device connected in Fastboot' },
  { title: 'Unlocking bootloader', active: 'Verifying bootloader state…', done: 'Bootloader ready' },
  { title: 'Downloading build package', active: 'Fetching factory image zip archive…', done: 'Image archive ready' },
  { title: 'Flashing build partitions', active: 'Writing boot, init_boot, system, vendor partitions…', done: 'Partitions written successfully' },
  { title: 'Rebooting device', active: 'Restarting device into new Android system…', done: 'Installation complete' },
];

function renderInstallSteps(currentIndex, customSubText, errorState = false) {
  const box = document.getElementById('status-box');
  const tpl = document.getElementById('status-row-template');
  box.innerHTML = '';
  installSteps.forEach((step, i) => {
    const row = tpl.content.cloneNode(true);
    const icon = row.querySelector('.status-icon');
    const title = row.querySelector('.status-title');
    const sub = row.querySelector('.status-sub');
    title.textContent = step.title;
    if (i < currentIndex) {
      icon.textContent = 'check_circle';
      icon.classList.add('done');
      sub.textContent = step.done;
    } else if (i === currentIndex) {
      if (errorState) {
        icon.textContent = 'cancel';
        icon.classList.add('error');
        sub.textContent = customSubText || 'Failed';
      } else {
        icon.textContent = 'progress_activity';
        icon.classList.add('active');
        sub.textContent = customSubText || ('In progress. ' + step.active);
      }
    } else {
      icon.textContent = 'radio_button_unchecked';
      icon.classList.add('pending');
      sub.textContent = 'Pending';
    }
    box.appendChild(row);
  });
}

document.getElementById('confirm-install').addEventListener('click', async () => {
  confirmModal.hidden = true;
  document.getElementById('build-selected-actions').hidden = true;
  document.getElementById('install-progress').hidden = false;
  cardTitle.textContent = 'Installing build';

  let currentStepIndex = 0;

  function updateProgress(stepIdx, msg, isError = false) {
    currentStepIndex = stepIdx;
    renderInstallSteps(stepIdx, msg, isError);
  }

    let isExpectingReboot = false;

    // A real cable/USB disconnect fires this regardless of what step we're
    // on, so surface it immediately rather than letting the in-flight
    // fastboot command time out silently.
    const disconnectListener = (event) => {
      if (isExpectingReboot) return;
      const liveDevice = getConnectedRawDevice();
      if (!liveDevice || event.device === liveDevice) {
        console.warn('Device disconnected during flash procedure:', event);
        updateProgress(currentStepIndex, 'Device disconnected unexpectedly.', true);
      }
    };
    navigator.usb?.addEventListener('disconnect', disconnectListener);

  try {
    updateProgress(0, 'Preparing device…');

    // If we're still holding an ADB session, reboot into the bootloader
    // and wait for the same physical device to re-enumerate as a
    // fastboot device — no "click OK, then pick it again" dialog needed.
    if (currentConnectedDevice?.mode === 'adb' && currentConnectedDevice.adbInstance) {
      const oldDevice = currentConnectedDevice.rawDevice || currentConnectedDevice.adbInstance.connection.transport.device;

      updateProgress(0, 'Rebooting into bootloader…');
      isExpectingReboot = true;
      try {
        await currentConnectedDevice.adbInstance.reboot('bootloader');
      } catch (e) {
        console.warn('ADB reboot command sent (device disconnecting):', e);
      }

      updateProgress(0, 'Please select your device in fastboot mode from the browser prompt…');
      const fastbootDevice = await requestFastbootDevice();
      isExpectingReboot = false;
      const transport = new WebUsbTransport(fastbootDevice);
      await transport.open();
      currentDriver = new FastbootDriver(transport);

      let product = currentConnectedDevice.product || 'tangorpro';
      try { product = (await currentDriver.getVar('product')) || product; } catch (e) {}

      currentConnectedDevice = {
        mode: 'fastboot',
        product,
        serial: transport.device.serialNumber || 'UNKNOWN_SERIAL',
        buildId: 'Fastboot Mode',
        arch: currentConnectedDevice.arch || 'arm64',
      };
      showConnectedDevice(currentConnectedDevice);
    }

    if (!currentDriver) {
      throw new Error('No active Fastboot driver session found for this device.');
    }
    updateProgress(0, 'Device connected in Fastboot mode');

    // Step 1: real bootloader lock state, read straight off the device.
    updateProgress(1, 'Checking bootloader lock status…');
    const unlockState = (await currentDriver.getVar('unlocked').catch(() => '') || '').trim().toLowerCase();
    if (unlockState === 'no' || unlockState === 'false') {
      updateProgress(1, 'Bootloader is locked — confirm "Unlock the bootloader" on the device screen…');
      await currentDriver.unlockBootloader();
    }
    updateProgress(1, 'Bootloader ready');

    // Step 2: real download, with byte-level progress from the response stream.
    if (!selectedBuild?.factoryImageDownloadUrl) {
      throw new Error('No download URL for the selected build.');
    }
    updateProgress(2, `Downloading ${selectedBuild.releaseCandidateName}…`);
    const response = await fetch(selectedBuild.factoryImageDownloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download factory image: HTTP ${response.status}`);
    }
    const totalBytes = Number(response.headers.get('content-length')) || 0;
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      const mb = (received / (1024 * 1024)).toFixed(1);
      const pct = totalBytes ? ` (${Math.floor((received / totalBytes) * 100)}%)` : '';
      updateProgress(2, `Downloading factory image: ${mb} MB${pct}…`);
    }
    const zipBlob = new Blob(chunks);
    updateProgress(2, `Downloaded ${(received / (1024 * 1024)).toFixed(1)} MB`);

    // Flash options, as set in the "Selected build" editor (pencil icon).
    // Disable Verity / Disable Verification aren't wired into flashAll()
    // yet (that requires patching vbmeta's AVB flags before it's flashed,
    // which flashall.js doesn't currently do), so those two are read but
    // not yet applied.
    const wantsWipe = document.getElementById('opt-wipe').checked;
    const lockAfterFlash = document.getElementById('opt-lock').checked;
    const force = document.getElementById('opt-force').checked;
    const skipSecondary = document.getElementById('opt-skip-secondary').checked;

    // Load liblp WASM module if available for super partition flashing optimization
    let liblpModule = null;
    if (window.LiblpModule) {
      try {
        updateProgress(3, 'Initializing liblp WASM module…');
        liblpModule = await window.LiblpModule();
      } catch (e) {
        console.warn('Failed to initialize liblp WASM module, falling back to standard flashing:', e);
      }
    }

    // Step 3: real flashing. update()/flashAll() do the actual USB work
    // (requirement checks, per-partition download+flash, super-partition
    // sync) and report real status/byte progress as they go — nothing
    // here is timed or simulated.
    await update(currentDriver, zipBlob, {
      reboot: false, // we report the reboot ourselves in step 4
      wantsWipe,
      force,
      skipSecondary,
      liblpModule,
      onStatus: (msg) => updateProgress(3, msg),
      onProgress: (partition, sent, total) => {
        const pct = total ? Math.floor((sent / total) * 100) : 0;
        updateProgress(3, `Flashing '${partition}': ${pct}%`);
      },
    });
    updateProgress(3, 'All build partitions flashed successfully');

    // Re-lock the bootloader if requested, before the final reboot.
    if (lockAfterFlash) {
      updateProgress(4, 'Locking bootloader…');
      await currentDriver.lockBootloader();
    }

    // Step 4: real reboot.
    updateProgress(4, 'Sending reboot command to device…');
    await currentDriver.reboot();
    updateProgress(4, 'Installation complete! Device is restarting.');
  } catch (err) {
    console.error('Flashing failed:', err);
    updateProgress(currentStepIndex, 'Error: ' + (err.message || 'Device disconnected or command failed'), true);
  } finally {
    navigator.usb?.removeEventListener('disconnect', disconnectListener);
  }
});
