// --- START OF FILE main.js ---

// --- Imports ---
// Assumes Three.js, OrbitControls, GLTFLoader are loaded via <script> tags in index.html

// --- Global Variables ---
let scene, camera, renderer, controls;
let currentSceneRoot = null;
let currentMesh = null;
let currentSceneId = null;
let instanceDetails = {};
let faceMapArray = null;
let selectedInstance = null;
let currentHighlightMesh = null;
let raycaster;
let mouse;
let fetchController = null;
let gltfLoader;
let modelCenter = new THREE.Vector3(0, 0, 0);
let currentTemporaryMarker = null;
let currentTemporaryBBoxHelper = null;
let persistentVisuals = {}; // Stores { marker, bbox } keyed by instanceId
let savedAnnotationsData = {}; // Stores { finalLabel, query, boundingBox } keyed by instanceId
const MAX_PERSISTENT_MARKERS = 200;
const TEMP_MARKER_COLOR = 0xff0000;
const TEMP_BBOX_COLOR = 0xff0000;
const PERSISTENT_MARKER_COLOR = 0x00cc00;
const PERSISTENT_BBOX_COLOR = 0x00cc00;
let pendingInstanceId = null;
let pendingLabel = null;
let pendingCategoryId = null;
let pendingRegionLabel = null;
let pendingRegionCode = null;
let clock;
let keysPressed = {};
const MOVEMENT_SPEED = 3.0;
const ROTATION_SPEED = 1.5;
const BOOST_FACTOR = 3.0;
const _worldUp = new THREE.Vector3(0, 0, 1);
let defaultCameraUp = _worldUp.clone();
const _qFixedOrbit = new THREE.Quaternion();
const _offsetFixedOrbit = new THREE.Vector3();
const _qRotateView = new THREE.Quaternion();
const _viewOffset = new THREE.Vector3();
const _newTargetPos = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
let validRegions = {}; // Stores fetched region code -> label mapping

// --- DOM Elements ---
let sceneSelector, loadSceneButton, viewerContainer, infoDiv, queryInput, saveButton,
    annotationSection, saveStatusDiv, loadingStatusDiv, errorStatusDiv,
    confirmationSection, pendingInstanceIdSpan, pendingCategoryIdSpan, pendingLabelSpan,
    pendingRegionLabelSpan, pendingRegionCodeSpan,
    labelModifyInput, confirmButton, cancelButton,
    existingAnnotationInfoP,
    viewModeToggle, presetViewButtons,
    regionSelect;

// --- Utility Functions ---
function showLoading(isLoading, message = "Loading...") {
    if (loadingStatusDiv) {
        loadingStatusDiv.textContent = message;
        loadingStatusDiv.style.display = isLoading ? 'block' : 'none';
    }
    if (loadSceneButton) loadSceneButton.disabled = !!isLoading;
    if (sceneSelector) sceneSelector.disabled = !!isLoading;
}

function showError(message) {
    if (errorStatusDiv) {
        errorStatusDiv.textContent = message ? `错误: ${message}` : "";
        errorStatusDiv.style.display = message ? 'block' : 'none';
    }
}

function showSaveStatus(message, isError = false) {
    if (!saveStatusDiv) return;
    saveStatusDiv.textContent = message;
    saveStatusDiv.style.color = isError ? 'red' : 'green';
    setTimeout(() => {
        if (saveStatusDiv && saveStatusDiv.textContent === message) {
            saveStatusDiv.textContent = "";
        }
    }, isError ? 6000 : 4000);
}

// --- Visualization Cleanup Functions ---
function clearTemporaryMarker() {
    if (currentTemporaryMarker) {
        scene?.remove(currentTemporaryMarker);
        currentTemporaryMarker.geometry?.dispose();
        currentTemporaryMarker.material?.dispose();
        currentTemporaryMarker = null;
    }
}

function clearTemporaryBBoxHelper() {
    if (currentTemporaryBBoxHelper) {
        scene?.remove(currentTemporaryBBoxHelper);
        currentTemporaryBBoxHelper.geometry?.dispose();
        currentTemporaryBBoxHelper.material?.dispose();
        currentTemporaryBBoxHelper = null;
    }
}

function clearHighlight() {
    // Remove yellow highlight mesh
    if (currentHighlightMesh) {
        scene?.remove(currentHighlightMesh);
        currentHighlightMesh.geometry?.dispose();
        (Array.isArray(currentHighlightMesh.material) ? currentHighlightMesh.material : [currentHighlightMesh.material]).forEach(m => m?.dispose());
        currentHighlightMesh = null;
    }
    // Also clear the temporary red bbox helper if it exists
    // Note: This might be called *after* the helper was potentially converted
    // to persistent in saveAnnotation. That's okay, as the reference
    // `currentTemporaryBBoxHelper` would have been nulled out there already.
    clearTemporaryBBoxHelper();
}

function clearAllPersistentVisuals() {
    console.log(`Clearing ${Object.keys(persistentVisuals).length} persistent visuals.`);
    for (const instanceId in persistentVisuals) {
        if (Object.prototype.hasOwnProperty.call(persistentVisuals, instanceId)) {
            const visuals = persistentVisuals[instanceId];
            // Safely remove and dispose marker
            if (visuals?.marker) {
                scene?.remove(visuals.marker);
                visuals.marker.geometry?.dispose();
                visuals.marker.material?.dispose();
            }
            // Safely remove and dispose bbox helper
            if (visuals?.bbox) {
                scene?.remove(visuals.bbox);
                visuals.bbox.geometry?.dispose();
                visuals.bbox.material?.dispose();
            }
        }
    }
    persistentVisuals = {};
}

// --- Animation loop ---
function animate() {
    requestAnimationFrame(animate);
    let delta = clock ? clock.getDelta() : 0;
    try {
        if (controls && camera && typeof handleKeyboardInput === 'function') {
            handleKeyboardInput(delta);
        }
        if (controls?.update) {
            controls.update(delta);
        }
    } catch (updateError) {
        console.error("Error during controls update:", updateError);
    }
    if (renderer && scene && camera) {
        try {
            renderer.render(scene, camera);
        } catch (renderError) {
            console.error("Error during rendering:", renderError);
        }
    }
}

// --- Window Resize Handler ---
function onWindowResize() {
    if (camera && renderer && viewerContainer) {
        camera.aspect = viewerContainer.clientWidth / viewerContainer.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(viewerContainer.clientWidth, viewerContainer.clientHeight);
    }
}

// --- Camera Fitting ---
function fitCameraToObject(object, offset = 1.5) {
    if (!(object instanceof THREE.Object3D) || !camera || !controls) return;
    const boundingBox = new THREE.Box3();
    try {
        object.updateMatrixWorld(true);
        boundingBox.setFromObject(object, true);
    } catch (e) {
        console.error("Error calculating bounding box for fitCameraToObject:", e);
        return;
    }
    if (boundingBox.isEmpty()) {
        console.warn("fitCameraToObject: Bounding box is empty.");
        return;
    }
    const center = new THREE.Vector3();
    boundingBox.getCenter(center);
    modelCenter.copy(center);
    const size = new THREE.Vector3();
    boundingBox.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim <= 0) {
        console.warn("fitCameraToObject: Model has zero dimensions.");
        controls.target.copy(center);
        controls.update();
        return;
    }
    const fov = camera.fov * (Math.PI / 180);
    let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
    cameraZ *= offset;
    const direction = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
    if (direction.lengthSq() < 0.0001) direction.set(0, -0.3, 1).normalize();
    const newCameraPosition = new THREE.Vector3().copy(center).addScaledVector(direction, cameraZ);
    if (![center.x, center.y, center.z, newCameraPosition.x, newCameraPosition.y, newCameraPosition.z, cameraZ].every(Number.isFinite)) {
        console.error("fitCameraToObject: Invalid numbers calculated.");
        return;
    }
    controls.target.copy(center);
    camera.position.copy(newCameraPosition);
    camera.near = Math.max(0.01, cameraZ / 1000);
    camera.far = cameraZ * 10;
    if (camera.near >= camera.far) camera.far = camera.near + 100;
    camera.up.copy(defaultCameraUp);
    camera.updateProjectionMatrix();
    controls.update();
    console.log(`fitCameraToObject Ran. Target: [${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)}]`);
}

// --- Marker and BBox Functions ---
function addTemporaryDebugMarker(position) {
    clearTemporaryMarker();
    if (!position || !scene) return;
    try {
        const geometry = new THREE.SphereGeometry(0.03, 16, 8);
        const material = new THREE.MeshBasicMaterial({color: TEMP_MARKER_COLOR, depthTest: false});
        currentTemporaryMarker = new THREE.Mesh(geometry, material);
        currentTemporaryMarker.position.copy(position);
        currentTemporaryMarker.renderOrder = 2;
        scene.add(currentTemporaryMarker);
    } catch (e) {
        console.error("Error creating debug marker:", e);
    }
}

function addPersistentMarker(position, instanceId) {
    if (!position || !scene || !instanceId) return null;
    try {
        const geometry = new THREE.SphereGeometry(0.04, 16, 8);
        const material = new THREE.MeshBasicMaterial({color: PERSISTENT_MARKER_COLOR, depthTest: false});
        const marker = new THREE.Mesh(geometry, material);
        marker.position.copy(position);
        marker.renderOrder = 2;
        scene.add(marker);
        return marker;
    } catch (e) {
        console.error(`Error creating persistent marker for instance ${instanceId}:`, e);
        return null;
    }
}

function addPersistentBBoxHelper(box3, instanceId) {
    if (!box3 || !(box3 instanceof THREE.Box3) || box3.isEmpty() || !scene || !instanceId) return null;
    try {
        const helper = new THREE.Box3Helper(box3, PERSISTENT_BBOX_COLOR);
        helper.renderOrder = 1;
        scene.add(helper);
        return helper;
    } catch (e) {
        console.error(`Error creating persistent bbox helper for instance ${instanceId}:`, e);
        return null;
    }
}

// --- UI State Functions ---
function hideConfirmationPrompt() {
    if (confirmationSection) confirmationSection.style.display = 'none';
    if (existingAnnotationInfoP) existingAnnotationInfoP.style.display = 'none';
    pendingInstanceId = null;
    pendingLabel = null;
    pendingCategoryId = null;
    pendingRegionLabel = null;
    pendingRegionCode = null;
    if (pendingInstanceIdSpan) pendingInstanceIdSpan.textContent = '';
    if (pendingCategoryIdSpan) pendingCategoryIdSpan.textContent = '';
    if (pendingLabelSpan) pendingLabelSpan.textContent = '';
    if (pendingRegionLabelSpan) pendingRegionLabelSpan.textContent = 'N/A';
    if (pendingRegionCodeSpan) pendingRegionCodeSpan.textContent = '-';
}

function resetAnnotationState() {
    selectedInstance = null;
    clearHighlight();
    clearTemporaryMarker();
    clearAllPersistentVisuals();
    savedAnnotationsData = {};
    instanceDetails = {};
    faceMapArray = null;
    if (infoDiv) infoDiv.textContent = 'Selected: None';
    if (labelModifyInput) labelModifyInput.value = '';
    if (queryInput) queryInput.value = '';
    if (regionSelect) {
        regionSelect.value = "";
    } // Reset dropdown selection
    if (saveButton) saveButton.disabled = true;
    if (annotationSection) annotationSection.style.display = 'none';
    if (saveStatusDiv) saveStatusDiv.textContent = '';
    hideConfirmationPrompt();
}

// --- Region Dropdown Population ---
function populateRegionDropdown() {
    if (!regionSelect) {
        console.error("Region select element not found.");
        return;
    }
    while (regionSelect.options.length > 1) {
        regionSelect.remove(1);
    } // Clear old options
    if (Object.keys(validRegions).length === 0) {
        regionSelect.options[0].textContent = "-- No Regions Available --";
        regionSelect.disabled = true;
        return;
    }
    regionSelect.options[0].textContent = "-- Select Region --";
    regionSelect.disabled = false;
    const sortedLabels = Object.entries(validRegions)
        .filter(([code, label]) => code !== '-' && label !== 'no label' && label !== 'junk' && !label.startsWith('Unknown Code')) // Filter out defaults/unknowns
        .sort(([, labelA], [, labelB]) => labelA.localeCompare(labelB)); // Sort alphabetically by label
    sortedLabels.forEach(([code, label]) => {
        const option = document.createElement('option');
        option.value = label;
        option.textContent = label;
        option.dataset.code = code; // Store code in data attribute
        regionSelect.appendChild(option);
    });
    console.log(`Populated region dropdown with ${sortedLabels.length} valid regions.`);
}

// --- Initialization ---
function init() {
    console.log("Initializing application...");
    try {
        // Get DOM Elements (ensure all are found)
        sceneSelector = document.getElementById('sceneSelector');
        loadSceneButton = document.getElementById('loadSceneButton');
        viewerContainer = document.getElementById('viewer');
        infoDiv = document.getElementById('info');
        queryInput = document.getElementById('queryInput');
        saveButton = document.getElementById('saveButton');
        annotationSection = document.getElementById('annotationSection');
        saveStatusDiv = document.getElementById('saveStatus');
        loadingStatusDiv = document.getElementById('loadingStatus');
        errorStatusDiv = document.getElementById('errorStatus');
        confirmationSection = document.getElementById('confirmationSection');
        pendingInstanceIdSpan = document.getElementById('pendingInstanceId');
        pendingCategoryIdSpan = document.getElementById('pendingCategoryId');
        pendingLabelSpan = document.getElementById('pendingLabel');
        pendingRegionLabelSpan = document.getElementById('pendingRegionLabel');
        pendingRegionCodeSpan = document.getElementById('pendingRegionCode');
        labelModifyInput = document.getElementById('labelModifyInput');
        confirmButton = document.getElementById('confirmButton');
        cancelButton = document.getElementById('cancelButton');
        existingAnnotationInfoP = document.getElementById('existingAnnotationInfo');
        viewModeToggle = document.getElementById('viewModeToggle');
        regionSelect = document.getElementById('regionSelect');
        presetViewButtons = {
            top: document.getElementById('presetTopBtn'),
            bottom: document.getElementById('presetBottomBtn'),
            front: document.getElementById('presetFrontBtn'),
            back: document.getElementById('presetBackBtn'),
            left: document.getElementById('presetLeftBtn'),
            right: document.getElementById('presetRightBtn')
        };
        const criticalElements = {
            viewerContainer,
            sceneSelector,
            loadSceneButton,
            confirmationSection,
            confirmButton,
            cancelButton,
            pendingInstanceIdSpan,
            pendingCategoryIdSpan,
            pendingLabelSpan,
            pendingRegionLabelSpan,
            pendingRegionCodeSpan,
            annotationSection,
            infoDiv,
            labelModifyInput,
            queryInput,
            saveButton,
            existingAnnotationInfoP,
            viewModeToggle,
            regionSelect, ...Object.values(presetViewButtons).filter(Boolean)
        };
        let missing = Object.entries(criticalElements).filter(([_, el]) => !el).map(([name]) => name);
        if (missing.length > 0) throw new Error(`Missing DOM element(s): ${missing.join(', ')}.`);
        console.log("All critical DOM elements found.");

        // Three.js Setup
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0xcccccc);
        camera = new THREE.PerspectiveCamera(75, viewerContainer.clientWidth / viewerContainer.clientHeight, 0.1, 1000);
        camera.position.set(0, -3, 3);
        camera.up.copy(defaultCameraUp);
        renderer = new THREE.WebGLRenderer({antialias: true});
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(viewerContainer.clientWidth, viewerContainer.clientHeight);
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.outputEncoding = THREE.sRGBEncoding;
        viewerContainer.appendChild(renderer.domElement);
        console.log("Renderer initialized.");
        // Controls
        if (typeof THREE.OrbitControls === 'undefined') throw new Error("OrbitControls not found.");
        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.1;
        controls.screenSpacePanning = true;
        controls.target.set(0, 0, 0);
        console.log("OrbitControls initialized.");
        // Raycaster & Lights
        raycaster = new THREE.Raycaster();
        mouse = new THREE.Vector2();
        scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const dl1 = new THREE.DirectionalLight(0xffffff, 0.7);
        dl1.position.set(5, -10, 7.5);
        scene.add(dl1);
        const dl2 = new THREE.DirectionalLight(0xffffff, 0.4);
        dl2.position.set(-5, 10, -5);
        scene.add(dl2);
        const hl = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
        hl.position.set(0, 0, 20);
        scene.add(hl);
        console.log("Lights and Raycaster added.");
        // Loader & Clock
        if (typeof THREE.GLTFLoader !== 'function') throw new Error("GLTFLoader not found.");
        gltfLoader = new THREE.GLTFLoader();
        console.log("GLTFLoader initialized.");
        clock = new THREE.Clock();
        console.log("Clock initialized.");
        // Event Listeners
        loadSceneButton.addEventListener('click', loadSelectedScene);
        viewerContainer.addEventListener('pointerdown', onPointerDown, false);
        saveButton.addEventListener('click', saveAnnotation);
        confirmButton.addEventListener('click', handleConfirmSelection);
        cancelButton.addEventListener('click', handleCancelSelection);
        viewModeToggle.addEventListener('change', handleViewModeChange);
        window.addEventListener('resize', onWindowResize);
        for (const [vt, btn] of Object.entries(presetViewButtons)) {
            if (btn) btn.addEventListener('click', ((t) => () => setPresetView(t))(vt));
        }
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        console.log("Event listeners added.");

        // Fetch Regions
        fetch('/get_regions')
            .then(response => response.ok ? response.json() : Promise.reject(`HTTP ${response.status}`))
            .then(data => {
                validRegions = data || {};
                console.log(`Fetched ${Object.keys(validRegions).length} regions.`);
                populateRegionDropdown();
            })
            .catch(error => {
                console.error("Error fetching regions:", error);
                showError("无法加载区域列表。");
                if (regionSelect) {
                    regionSelect.options[0].textContent = "-- Error --";
                    regionSelect.disabled = true;
                }
            });

        animate();
        console.log("Initialization finished successfully.");
    } catch (error) {
        console.error("FATAL ERROR during initialization:", error); /* ... error display ... */
    }
}

// --- Core Functions ---
function loadSelectedScene() {
    const selectedSceneId = sceneSelector.value;
    if (!selectedSceneId) {
        showError("请选择一个场景。");
        return;
    }
    console.log(`Loading scene: ${selectedSceneId}...`);
    showLoading(true, `Loading ${selectedSceneId}...`);
    showError(null);
    clearScene();
    if (fetchController) fetchController.abort();
    fetchController = new AbortController();
    const signal = fetchController.signal;
    fetch(`/load_scene/${selectedSceneId}`, {signal})
        .then(response => response.ok ? response.json() : response.json().catch(() => ({})).then(err => Promise.reject(err.description || `Server ${response.status}`)))
        .then(data => {
            if (data.status !== 'success' || !data.glb_url || !data.details_url || !data.face_map_url) throw new Error(data.message || "Invalid data format");
            console.log(`URLs received.`);
            savedAnnotationsData = data.existing_annotations || {};
            console.log(`${Object.keys(savedAnnotationsData).length} existing annotations.`);
            showLoading(true, "Loading assets...");
            console.time(`Scene ${selectedSceneId} Assets`);
            return Promise.all([
                loadGLBModel(data.glb_url, signal),
                fetch(data.details_url, {signal}).then(res => res.ok ? res.json() : Promise.reject(`Details ${res.status}`)),
                fetch(data.face_map_url, {signal}).then(res => res.ok ? res.arrayBuffer() : Promise.reject(`Face map ${res.status}`))]);
        })
        .then(([mesh, details, buffer]) => {
            console.timeEnd(`Scene ${selectedSceneId} Assets`);
            if (signal.aborted) throw new Error('Aborted');
            if (!(mesh instanceof THREE.Object3D)) throw new Error("Invalid mesh");
            currentMesh = mesh;
            instanceDetails = details;
            try {
                faceMapArray = new Int32Array(buffer);
            } catch (e) {
                throw new Error("Face map process error");
            }
            console.log(`${Object.keys(instanceDetails).length} details, ${faceMapArray.length} faces mapped.`);
            currentSceneId = selectedSceneId;
            scene.add(currentMesh);
            displayExistingAnnotations();
            fitCameraToObject(currentMesh, 1.8);
            showLoading(false);
            fetchController = null;
            console.log(`Scene ${selectedSceneId} loaded.`);
        })
        .catch(error => {
            if (error.name === 'AbortError' || error.message === 'Aborted') console.log(`Load aborted for ${selectedSceneId}.`);
            else {
                console.error(`Error loading ${selectedSceneId}:`, error);
                showError(`加载失败: ${error.message || error}`);
                clearScene();
            }
            showLoading(false);
            fetchController = null;
        });
}

function displayExistingAnnotations() {
    if (!scene) return;
    console.log(`Displaying ${Object.keys(savedAnnotationsData).length} annotations.`);
    clearAllPersistentVisuals();
    let displayed = 0, skipped = 0;
    const ids = Object.keys(savedAnnotationsData);
    for (const id of ids) {
        if (Object.prototype.hasOwnProperty.call(savedAnnotationsData, id)) {
            const ann = savedAnnotationsData[id];
            if (ann?.boundingBox) {
                try {
                    const bb = ann.boundingBox;
                    if (bb.min && bb.max && typeof bb.min.x === 'number' && typeof bb.max.x === 'number') {
                        const minV = new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z);
                        const maxV = new THREE.Vector3(bb.max.x, bb.max.y, bb.max.z);
                        const box = new THREE.Box3(minV, maxV);
                        if (!box.isEmpty()) {
                            if (Object.keys(persistentVisuals).length >= MAX_PERSISTENT_MARKERS) {
                                console.warn(`Max visuals reached.`);
                                break;
                            }
                            const center = new THREE.Vector3();
                            box.getCenter(center);
                            const pMarker = addPersistentMarker(center, id);
                            const pBbox = addPersistentBBoxHelper(box, id);
                            persistentVisuals[id] = {marker: pMarker, bbox: pBbox};
                            displayed++;
                        } else {
                            console.warn(`Anno ${id}: BBox empty.`);
                            persistentVisuals[id] = null;
                            skipped++;
                        }
                    } else {
                        console.warn(`Anno ${id}: Invalid BBox format.`);
                        persistentVisuals[id] = null;
                        skipped++;
                    }
                } catch (e) {
                    console.error(`Error processing BBox for ${id}:`, e);
                    persistentVisuals[id] = null;
                    skipped++;
                }
            } else {
                console.log(`Anno ${id}: No BBox.`);
                persistentVisuals[id] = null;
                skipped++;
            }
        }
    }
    console.log(`Displayed ${displayed} visuals, skipped ${skipped}.`);
}

function loadGLBModel(url, signal) {
    return new Promise((resolve, reject) => {
        if (!gltfLoader) return reject(new Error("GLTFLoader missing"));
        console.log("Loading GLB:", url);
        const startT = performance.now();
        showLoading(true, "Loading model...");
        gltfLoader.load(url, (gltf) => {
                console.log(`GLB parsed in ${((performance.now() - startT) / 1000).toFixed(2)}s.`);
                const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
                if (!(root instanceof THREE.Object3D)) return reject(new Error("No valid scene in GLB"));
                currentSceneRoot = root;
                root.traverse(node => {
                    if (node.isMesh) {
                        const mats = Array.isArray(node.material) ? node.material : [node.material];
                        mats.forEach(m => {
                            if (m instanceof THREE.Material) {
                                m.vertexColors = true;
                                m.side = THREE.FrontSide;
                                m.needsUpdate = true;
                            }
                        });
                    }
                });
                resolve(root);
            }, (xhr) => {
                if (signal?.aborted) return;
                if (xhr.lengthComputable) showLoading(true, `Loading model: ${Math.round(xhr.loaded / xhr.total * 100)}%`); else showLoading(true, `Loading model: ${Math.round(xhr.loaded / 1024 ** 2)} MB`);
            },
            (error) => {
                console.error("GLB Load Error:", error);
                if (signal?.aborted) reject(new Error('GLB aborted')); else {
                    let msg = `Failed GLB: ${error.message || 'Unknown'}`;
                    if (error.target?.status) msg += ` (Status ${error.target.status})`;
                    reject(new Error(msg));
                }
            });
        if (signal) signal.addEventListener('abort', () => reject(new Error('GLB aborted')), {once: true});
    });
}

function onPointerDown(event) {
    if (!currentMesh || !camera || !raycaster || !viewerContainer || !faceMapArray || !instanceDetails) return;
    clearTemporaryMarker();
    try {
        const rect = viewerContainer.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObject(currentMesh, true);
        if (intersects.length > 0) {
            const intersection = intersects[0];
            const faceIndex = intersection.faceIndex;
            const point = intersection.point;
            if (faceIndex >= 0 && faceIndex < faceMapArray.length) {
                const clickedInstanceId = faceMapArray[faceIndex];
                if (clickedInstanceId >= 0 && instanceDetails.hasOwnProperty(clickedInstanceId)) {
                    const instanceData = instanceDetails[clickedInstanceId];
                    const instanceIdStr = String(clickedInstanceId);
                    console.log(`Clicked Face: ${faceIndex}, Instance ID: ${instanceIdStr}, Label: ${instanceData.label}`);
                    addTemporaryDebugMarker(point);
                    pendingInstanceId = instanceIdStr;
                    pendingLabel = instanceData.label;
                    pendingCategoryId = instanceData.category_id;
                    pendingRegionLabel = instanceData.region_label || "N/A";
                    pendingRegionCode = instanceData.region_code || "-";
                    if (pendingInstanceIdSpan) pendingInstanceIdSpan.textContent = pendingInstanceId;
                    if (pendingCategoryIdSpan) pendingCategoryIdSpan.textContent = pendingCategoryId;
                    if (pendingLabelSpan) pendingLabelSpan.textContent = pendingLabel;
                    if (pendingRegionLabelSpan) pendingRegionLabelSpan.textContent = pendingRegionLabel;
                    if (pendingRegionCodeSpan) pendingRegionCodeSpan.textContent = pendingRegionCode;
                    // --- Check and display existing annotation ---
                    if (savedAnnotationsData.hasOwnProperty(instanceIdStr)) {
                        const savedData = savedAnnotationsData[instanceIdStr];
                        if (existingAnnotationInfoP) {
                            existingAnnotationInfoP.innerHTML = `已标注: <strong>${savedData.finalLabel}</strong><br>查询: "${savedData.query || '无'}"`;
                            existingAnnotationInfoP.style.display = 'block'; // Make sure it's shown
                        }
                        console.log(`Instance ${instanceIdStr} has saved data:`, savedData);
                    } else {
                        if (existingAnnotationInfoP) existingAnnotationInfoP.style.display = 'none'; // Hide if no saved data
                    }
                    // --- End check ---
                    if (confirmationSection) confirmationSection.style.display = 'block';
                    if (annotationSection) annotationSection.style.display = 'none';
                    clearHighlight();
                } else {
                    console.warn(`Face ${faceIndex} maps to invalid ID ${clickedInstanceId}`);
                    showError(`点击区域无效 (ID: ${clickedInstanceId})`);
                    hideConfirmationPrompt();
                    clearHighlight();
                }
            } else {
                console.warn(`Face index ${faceIndex} out of bounds`);
                showError("点击索引无效");
                hideConfirmationPrompt();
                clearHighlight();
            }
        } else {
            console.log("Click missed mesh");
            if (confirmationSection?.style.display === 'block') {
                hideConfirmationPrompt();
                clearTemporaryMarker();
            }
        }
    } catch (e) {
        console.error("Pointer down error:", e);
        showError("点击处理错误");
        hideConfirmationPrompt();
        clearTemporaryMarker();
        clearHighlight();
    }
}

function handleCancelSelection() {
    console.log("Selection cancelled.");
    hideConfirmationPrompt();
    clearTemporaryMarker();
}

function handleConfirmSelection() {
    if (pendingInstanceId === null) return;
    const instanceIdStr = String(pendingInstanceId);
    console.log(`Confirmed selection: Instance ${instanceIdStr}`);
    selectedInstance = {id: instanceIdStr, label: pendingLabel, categoryId: pendingCategoryId, regionLabel: pendingRegionLabel, regionCode: pendingRegionCode, boundingBox: null};
    hideConfirmationPrompt();
    if (existingAnnotationInfoP) existingAnnotationInfoP.style.display = 'none';
    if (infoDiv) infoDiv.innerHTML = `已选: 实例 <strong>${selectedInstance.id}</strong> (初始标签: <strong>${selectedInstance.label}</strong>, CatID: ${selectedInstance.categoryId}, 区域: <strong>${selectedInstance.regionLabel}</strong> (${selectedInstance.regionCode || '-'}))`;
    let existingQuery = '';
    let existingLabel = selectedInstance.label;
    if (savedAnnotationsData.hasOwnProperty(instanceIdStr)) {
        const saved = savedAnnotationsData[instanceIdStr];
        existingLabel = saved.finalLabel;
        existingQuery = saved.query || '';
        console.log("Prefilling from saved.");
    }
    if (labelModifyInput) labelModifyInput.value = existingLabel;
    if (queryInput) {
        queryInput.value = existingQuery;
        queryInput.placeholder = `描述 '${existingLabel}' (${selectedInstance.regionLabel})...`;
    }
    // Set region dropdown default
    if (regionSelect) {
        const currentRegionLabel = selectedInstance.regionLabel;
        let found = false;
        for (let i = 0; i < regionSelect.options.length; i++) {
            if (regionSelect.options[i].value === currentRegionLabel) {
                regionSelect.selectedIndex = i;
                found = true;
                break;
            }
        }
        if (!found) regionSelect.selectedIndex = 0;
        regionSelect.disabled = false;
    }
    if (saveButton) saveButton.disabled = false;
    if (annotationSection) annotationSection.style.display = 'block';
    highlightInstance(selectedInstance.id, selectedInstance.label);
}

function highlightInstance(targetInstanceId, targetLabel) {
    if (!currentMesh || !faceMapArray || !scene) {
        console.warn("Highlight prerequisites missing.");
        return;
    }
    clearHighlight();
    console.log(`Highlighting Instance ID: ${targetInstanceId}`);
    let meshGeometry = null, worldMatrix = null, targetMeshNode = null;
    currentMesh.traverse(node => {
        if (!targetMeshNode && node.isMesh && node.visible && node.geometry?.index && node.geometry?.attributes?.position) {
            targetMeshNode = node;
            meshGeometry = node.geometry;
            node.updateMatrixWorld(true);
            worldMatrix = node.matrixWorld;
        }
    });
    if (!targetMeshNode) {
        console.error("Highlight: Valid mesh node not found.");
        showError("高亮错误: 几何数据无效。");
        if (selectedInstance) selectedInstance.boundingBox = null;
        return;
    }
    const vertices = [], colors = [];
    const positionAttribute = meshGeometry.attributes.position;
    const indexAttribute = meshGeometry.index;
    let facesFound = 0;
    const tempVec = new THREE.Vector3();
    const targetIdNum = parseInt(targetInstanceId, 10);
    const numFaceIndicesTotal = indexAttribute.count;
    for (let faceIndex = 0; faceIndex < faceMapArray.length; faceIndex++) {
        if (faceMapArray[faceIndex] === targetIdNum) {
            const baseVertexIndex = faceIndex * 3;
            if (baseVertexIndex + 2 < numFaceIndicesTotal) {
                facesFound++;
                const a = indexAttribute.getX(baseVertexIndex), b = indexAttribute.getX(baseVertexIndex + 1), c = indexAttribute.getX(baseVertexIndex + 2);
                const vA = tempVec.fromBufferAttribute(positionAttribute, a).clone().applyMatrix4(worldMatrix);
                const vB = tempVec.fromBufferAttribute(positionAttribute, b).clone().applyMatrix4(worldMatrix);
                const vC = tempVec.fromBufferAttribute(positionAttribute, c).clone().applyMatrix4(worldMatrix);
                vertices.push(vA.x, vA.y, vA.z, vB.x, vB.y, vB.z, vC.x, vC.y, vC.z);
                const tc = new THREE.Color(0xffff00);
                colors.push(tc.r, tc.g, tc.b, tc.r, tc.g, tc.b, tc.r, tc.g, tc.b);
            } else {
                console.warn(`Highlight: Face index ${faceIndex} OOB for geometry index.`);
            }
        }
    }
    if (facesFound === 0) {
        console.warn(`Highlight: No faces found for ${targetInstanceId}.`);
        if (selectedInstance) selectedInstance.boundingBox = null;
        return;
    }
    console.log(`Highlight: Found ${facesFound} faces. Creating geometry...`);
    const highlightGeometry = new THREE.BufferGeometry();
    highlightGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    highlightGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const highlightMaterial = new THREE.MeshBasicMaterial({vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.6, depthTest: false});
    currentHighlightMesh = new THREE.Mesh(highlightGeometry, highlightMaterial);
    currentHighlightMesh.renderOrder = 1;
    let calculatedBoundingBox = null;
    try {
        highlightGeometry.computeBoundingBox();
        if (highlightGeometry.boundingBox && !highlightGeometry.boundingBox.isEmpty()) {
            const box = highlightGeometry.boundingBox.clone();
            clearTemporaryBBoxHelper();
            currentTemporaryBBoxHelper = new THREE.Box3Helper(box, TEMP_BBOX_COLOR);
            currentTemporaryBBoxHelper.renderOrder = 2;
            scene.add(currentTemporaryBBoxHelper);
            calculatedBoundingBox = {min: {x: box.min.x, y: box.min.y, z: box.min.z}, max: {x: box.max.x, y: box.max.y, z: box.max.z}};
        }
    } catch (bboxError) {
        console.error("Highlight bbox error:", bboxError);
    }
    if (selectedInstance) selectedInstance.boundingBox = calculatedBoundingBox; else console.warn("Highlight: No selectedInstance to store bbox.");
    scene.add(currentHighlightMesh);
    console.log("Highlight mesh added.");
}

function clearScene() {
    console.log("Clearing scene...");
    resetAnnotationState();
    if (currentMesh?.parent === scene) {
        scene.remove(currentMesh);
        console.log("Removed mesh.");
        currentMesh.traverse(node => {
            if (node.isMesh) {
                node.geometry?.dispose();
                if (node.material) {
                    (Array.isArray(node.material) ? node.material : [node.material]).forEach(m => {
                        if (m) {
                            for (const k in m) {
                                const v = m[k];
                                if (v && v.isTexture) v.dispose();
                            }
                            m.dispose();
                        }
                    });
                }
            }
        });
        console.log("Disposed resources.");
    }
    currentMesh = null;
    currentSceneId = null;
    currentSceneRoot = null;
    modelCenter.set(0, 0, 0);
    console.log("Scene clear complete.");
}

// --- 修改: saveAnnotation 调整 clearHighlight 调用时机 ---
function saveAnnotation() {
    if (!selectedInstance || !currentSceneId) {
        showSaveStatus("错误: 无选择。", true);
        return;
    }
    const finalLabel = labelModifyInput?.value.trim() ?? '';
    const query = queryInput?.value.trim() ?? '';
    if (!finalLabel || !query) {
        showSaveStatus("错误: 需标签和查询。", true);
        return;
    }

    let finalRegionLabel = "";
    let finalRegionCode = "-";
    if (regionSelect && regionSelect.selectedIndex > 0) {
        const selectedOption = regionSelect.options[regionSelect.selectedIndex];
        finalRegionLabel = selectedOption.value;
        finalRegionCode = selectedOption.dataset.code || "-";
    } else { // Use original if none selected or invalid selection
        finalRegionLabel = selectedInstance.regionLabel || "N/A";
        finalRegionCode = selectedInstance.regionCode || "-";
        console.warn("No valid region selected, using original.");
        // Or force selection: showSaveStatus("错误: 请选择区域。", true); return;
    }

    const instanceIdStr = String(selectedInstance.id);
    const annotationData = {
        scene_id: currentSceneId, instance_id: instanceIdStr, original_category_id: selectedInstance.categoryId,
        final_label_string: finalLabel, query: query, bounding_box: selectedInstance.boundingBox,
        final_region_label: finalRegionLabel, final_region_code: finalRegionCode
    };
    console.log("Saving annotation:", JSON.stringify(annotationData, null, 2));
    showSaveStatus("正在保存...", false);
    if (saveButton) saveButton.disabled = true;

    fetch('/save_annotation', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(annotationData)})
        .then(response => response.ok ? response.json() : response.json().catch(() => ({})).then(err => Promise.reject(err.description || `Server ${response.status}`)))
        .then(data => {
            if (data.status === 'success') {
                showSaveStatus(`保存成功! 标签: '${data.saved_label}'`, false);
                console.log("Annotation saved:", data);

                let newMarker = null;
                let newBbox = null;

                // --- Convert Visuals ---
                // Important: Do this *before* calling clearHighlight
                if (currentTemporaryMarker) {
                    newMarker = currentTemporaryMarker;
                    newMarker.material.color.setHex(PERSISTENT_MARKER_COLOR);
                    currentTemporaryMarker = null; // Nullify temporary reference
                    console.log(`Converted marker to persistent for ${instanceIdStr}`);
                }
                if (currentTemporaryBBoxHelper) {
                    newBbox = currentTemporaryBBoxHelper;
                    newBbox.material.color.setHex(PERSISTENT_BBOX_COLOR);
                    currentTemporaryBBoxHelper = null; // Nullify temporary reference
                    console.log(`Converted bbox helper to persistent for ${instanceIdStr}`);
                }

                // --- Update Persistent Store ---
                if (persistentVisuals.hasOwnProperty(instanceIdStr)) {
                    const old = persistentVisuals[instanceIdStr];
                    if (old.marker) {
                        scene?.remove(old.marker);
                        old.marker.geometry?.dispose();
                        old.marker.material?.dispose();
                    }
                    if (old.bbox) {
                        scene?.remove(old.bbox);
                        old.bbox.geometry?.dispose();
                        old.bbox.material?.dispose();
                    }
                    console.log(`Removed old persistent visuals for ${instanceIdStr}.`);
                }
                // Optional: Max limit check (logic omitted for brevity, see previous versions)
                // if (Object.keys(persistentVisuals).length >= MAX...) { /* remove oldest */ }
                persistentVisuals[instanceIdStr] = {marker: newMarker, bbox: newBbox}; // Store new visuals (can be null)
                console.log(`Stored persistent visuals for ${instanceIdStr}. Marker: ${!!newMarker}, BBox: ${!!newBbox}`);

                // --- Update Local Cache ---
                savedAnnotationsData[instanceIdStr] = {
                    finalLabel: data.saved_label,
                    query: query,
                    boundingBox: selectedInstance.boundingBox // Save the bbox data used
                    // Storing finalRegionLabel/Code here is optional
                };
                console.log(`Updated local cache for ${instanceIdStr}.`);

                // --- UI State & Cleanup ---
                if (saveButton) saveButton.disabled = false;

                // <<< Call clearHighlight AFTER processing visuals >>>
                clearHighlight(); // Now safe to clear yellow mesh (temp helper ref is already null)

            } else {
                throw new Error(data.message || "Save failed.");
            }
        })
        .catch(error => {
            console.error("Error saving annotation:", error);
            showSaveStatus(`保存失败: ${error.message}`, true);
            if (saveButton && selectedInstance) saveButton.disabled = false;
        });
}

// --- End ---


// --- View Mode / Preset Views / Keyboard Handlers ---

function handleViewModeChange() {
    if (!currentSceneRoot || !viewModeToggle) {
        console.warn("View mode change aborted: currentSceneRoot or viewModeToggle missing.");
        return;
    }
    const mode = viewModeToggle.value; // Get selected mode ('front', 'back', 'double')
    let side; // THREE.Side constant

    // Map dropdown value to THREE.js side constant
    switch (mode) {
        case 'front':
            side = THREE.FrontSide;
            break;
        case 'back':
            side = THREE.BackSide;
            break;
        case 'double':
            side = THREE.DoubleSide;
            break;
        default:
            console.warn("Unknown view mode selected:", mode);
            return; // Do nothing if mode is unrecognized
    }

    console.log(`Setting view mode to: ${mode} (Material Side: ${side})`);
    let updatedMaterialCount = 0;

    // Traverse the loaded scene graph (starting from the root)
    currentSceneRoot.traverse(node => {
        // Apply the change to all materials found on mesh nodes
        if (node.isMesh && node.material) {
            // Handle both single material and array of materials
            const materials = Array.isArray(node.material) ? node.material : [node.material];
            materials.forEach((mat, index) => {
                if (mat instanceof THREE.Material) {
                    // Set the 'side' property of the material
                    mat.side = side;
                    // Mark the material as needing an update for the change to take effect
                    mat.needsUpdate = true;
                    updatedMaterialCount++;
                } else {
                    // Log a warning if an element in the material array is not a valid material
                    console.warn(`Node ${node.name || node.uuid} has a non-material element at material index ${index}`);
                }
            });
        }
    });

    if (updatedMaterialCount === 0) {
        console.warn("View mode change: No materials were found or updated in the scene graph.");
    } else {
        console.log(`View mode change: Updated 'side' property for ${updatedMaterialCount} materials.`);
    }
    // No explicit redraw needed, the animation loop handles rendering
}

function setPresetView(viewType) {
    if (!camera || !controls || !currentMesh || !(currentMesh instanceof THREE.Object3D)) {
        console.warn("Set preset view requirements not met (camera, controls, currentMesh).");
        return;
    }
    console.log("Setting preset view:", viewType);

    // --- 1. Calculate Bounding Box ---
    const boundingBox = new THREE.Box3();
    try {
        currentMesh.updateMatrixWorld(true); // Ensure world matrix is up-to-date
        boundingBox.setFromObject(currentMesh, true); // Calculate world bounds
    } catch (e) {
        console.error("Error calculating bounding box for preset view:", e);
        return;
    }

    if (boundingBox.isEmpty()) {
        console.warn("Preset view: Cannot set view, bounding box is empty.");
        return;
    }

    // --- 2. Get Center and Size ---
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    boundingBox.getCenter(center);
    boundingBox.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);

    if (maxDim <= 0) {
        console.warn("Preset view: Bounding box has zero size.");
        // Set target to center, keep camera position as is? Or move to default?
        controls.target.copy(center);
        controls.update();
        return;
    }

    // --- 3. Calculate Camera Distance ---
    const fov = camera.fov * (Math.PI / 180);
    const fitOffset = maxDim / (2 * Math.tan(fov / 2)); // Base distance to fit object
    const distance = fitOffset * 1.8; // Add buffer distance (multiplier > 1)

    // --- 4. Determine Position and Up Vector based on View Type ---
    const worldZUp = _worldUp.clone(); // Use the globally defined world up vector
    let position = new THREE.Vector3(); // Camera position
    let up = worldZUp.clone(); // Camera up vector (defaults to world up)

    switch (viewType) {
        case 'top': // View from Z+ looking down
            position.set(center.x, center.y, center.z + distance);
            up.set(0, 1, 0); // For top view, Y should point "up" in the view usually
            break;
        case 'bottom': // View from Z- looking up
            position.set(center.x, center.y, center.z - distance);
            up.set(0, 1, 0); // Y still points "up" in the view
            break;
        case 'front': // View from Y- looking towards Y+
            position.set(center.x, center.y - distance, center.z);
            up.copy(worldZUp); // Z is up
            break;
        case 'back': // View from Y+ looking towards Y-
            position.set(center.x, center.y + distance, center.z);
            up.copy(worldZUp); // Z is up
            break;
        case 'left': // View from X- looking towards X+
            position.set(center.x - distance, center.y, center.z);
            up.copy(worldZUp); // Z is up
            break;
        case 'right': // View from X+ looking towards X-
            position.set(center.x + distance, center.y, center.z);
            up.copy(worldZUp); // Z is up
            break;
        default:
            console.warn("Unknown preset view type:", viewType);
            return; // Exit if view type is not recognized
    }

    // --- 5. Sanity Check and Apply ---
    if (![position.x, position.y, position.z, center.x, center.y, center.z, distance].every(Number.isFinite)) {
        console.error("Preset view calculation resulted in invalid numbers. Aborting.");
        return;
    }

    controls.target.copy(center); // Set OrbitControls target to model center
    camera.position.copy(position); // Set camera position
    camera.up.copy(up); // Set camera up vector

    // Adjust near/far planes based on distance
    camera.near = Math.max(0.01, distance / 1000);
    camera.far = distance * 10;
    if (camera.near >= camera.far) camera.far = camera.near + 100;
    camera.updateProjectionMatrix(); // Apply near/far changes

    controls.update(); // Force OrbitControls to update its internal state and lookAt target
    console.log(`Preset view '${viewType}' set. Target: [${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)}]`);
}


function handleKeyDown(event) {
    // Ignore keydown events if an input field or textarea has focus
    const activeElement = document.activeElement;
    if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable)) {
        return;
    }

    const key = event.key.toLowerCase(); // Use lowercase for consistency
    keysPressed[key] = true; // Mark the key as pressed

    // Prevent default browser actions (like scrolling with arrow keys or space)
    // for keys used by the application's camera controls.
    if (['w', 'a', 's', 'd', 'q', 'e', 'z', 'c', 'f', 'v', 'b', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
        event.preventDefault();
    }
}


function handleKeyUp(event) {
    // Mark the key as released
    keysPressed[event.key.toLowerCase()] = false;
}


function handleKeyboardInput(delta) {
    // This function is called every frame from the animate loop
    if (!camera || !controls) return; // Ensure camera and controls are available

    // Handle different types of keyboard actions
    const translated = handleKeyboardTranslation(delta); // WASDQE movement
    const yawRotated = handleCameraViewRotation(delta);     // Z/C for yaw (turning left/right)
    const pitchRotated = handleCameraPitchRotation(delta); // V/B for pitch (looking up/down)

    // Handle discrete actions like 'Focus' (F key)
    if (keysPressed['f']) {
        focusOnSelectedObject();
        keysPressed['f'] = false; // Treat 'F' as a single-press action, reset flag immediately
    }

    // Note: OrbitControls.update() is called after this function in the main animate loop.
    // It will apply the changes made to controls.target by the rotation functions.
}


function handleKeyboardTranslation(delta) {
    if (!camera || !controls) return false; // Need camera and controls

    // Calculate movement speed based on delta time and boost factor
    const speed = MOVEMENT_SPEED * delta * (keysPressed['shift'] ? BOOST_FACTOR : 1);
    if (speed <= 0) return false; // No movement if speed is zero

    let moved = false; // Flag to track if movement occurred

    // Define movement axes relative to camera and world
    const _up = _worldUp; // Use WORLD up for Q/E (vertical) movement
    camera.getWorldDirection(_forward); // Get the direction the camera is looking (normalized)
    _right.crossVectors(_forward, camera.up).normalize(); // Calculate right vector relative to camera's current orientation

    // Determine movement direction based on pressed keys
    const moveDirection = new THREE.Vector3(0, 0, 0); // Reset move direction each frame
    if (keysPressed['w']) moveDirection.add(_forward); // Move forward
    if (keysPressed['s']) moveDirection.sub(_forward); // Move backward
    if (keysPressed['a']) moveDirection.sub(_right);   // Strafe left
    if (keysPressed['d']) moveDirection.add(_right);   // Strafe right
    if (keysPressed['q']) moveDirection.sub(_up);      // Move down (along World Z)
    if (keysPressed['e']) moveDirection.add(_up);      // Move up (along World Z)

    // If any movement key is pressed, apply the translation
    if (moveDirection.lengthSq() > 0.0001) { // Check if direction is non-zero
        moveDirection.normalize().multiplyScalar(speed); // Normalize and scale by speed

        // Calculate new camera position and target position (pan target along with camera)
        const newPos = camera.position.clone().add(moveDirection);
        const newTarget = controls.target.clone().add(moveDirection);

        // Apply the new positions if they are valid numbers
        if ([newPos.x, newPos.y, newPos.z, newTarget.x, newTarget.y, newTarget.z].every(Number.isFinite)) {
            camera.position.copy(newPos);
            controls.target.copy(newTarget);
            moved = true; // Mark that movement occurred
        } else {
            console.warn("Keyboard translation resulted in invalid position/target values.");
        }
    }
    return moved; // Return whether movement happened
}


/**
 * Handles camera yaw rotation (turning left/right) around the World Z axis (or specified up axis).
 * This rotates the camera's target point around the camera's position.
 * @param {number} delta - Time delta since last frame.
 * @returns {boolean} - True if rotation occurred, false otherwise.
 */
function handleCameraViewRotation(delta) {
    if (!camera || !controls) return false; // Need camera and controls

    // Calculate rotation angle based on delta time and boost factor
    const rotationAngle = ROTATION_SPEED * delta * (keysPressed['shift'] ? BOOST_FACTOR : 1);
    let angle = 0;

    // Determine rotation direction based on Z/C keys
    if (keysPressed['z']) angle = rotationAngle;  // Turn left
    else if (keysPressed['c']) angle = -rotationAngle; // Turn right
    else return false; // No rotation keys pressed

    // --- Rotation Logic ---
    const rotationAxis = _worldUp; // Define the axis of rotation (e.g., World Z for yaw)

    // Create a quaternion representing the rotation around the axis
    _qRotateView.setFromAxisAngle(rotationAxis, angle);

    // Calculate the vector from the camera to the current target
    _viewOffset.copy(controls.target).sub(camera.position);

    // Apply the rotation to this offset vector
    _viewOffset.applyQuaternion(_qRotateView);

    // Calculate the new target position by adding the rotated offset back to the camera position
    _newTargetPos.copy(camera.position).add(_viewOffset);

    // Update ONLY the controls target. OrbitControls.update() will handle camera orientation.
    controls.target.copy(_newTargetPos);

    // Ensure camera.up remains aligned (helps prevent unwanted roll)
    camera.up.copy(defaultCameraUp);
    // --- End Rotation Logic ---

    return true; // Rotation happened
}


/**
 * Handles camera pitch rotation (looking up/down) without changing position.
 * Rotates the camera's target around the camera's local right-axis.
 * Includes pitch limits to prevent looking directly up/down or flipping over.
 * @param {number} delta - Time delta for frame-rate independent rotation.
 * @returns {boolean} - True if rotation occurred, false otherwise.
 */
function handleCameraPitchRotation(delta) {
    if (!camera || !controls) return false; // Need camera and controls

    // Calculate rotation angle based on delta time and boost factor
    const rotationAngle = ROTATION_SPEED * delta * (keysPressed['shift'] ? BOOST_FACTOR : 1);
    let angle = 0;

    // Determine rotation direction based on V/B keys
    // V = look up (negative pitch angle relative to local right axis rotation)
    // B = look down (positive pitch angle relative to local right axis rotation)
    if (keysPressed['v']) angle = -rotationAngle;
    else if (keysPressed['b']) angle = rotationAngle;
    else return false; // No pitch keys pressed

    // --- Rotation Logic ---
    // 1. Calculate the camera's local right vector (this is the axis of rotation for pitch)
    camera.getWorldDirection(_forward); // Get current look direction
    if (_forward.lengthSq() < 0.0001) {
        console.warn("Pitch Rotation: Camera forward vector is zero.");
        return false; // Avoid issues if forward vector is invalid
    }
    // Calculate right vector using cross product of forward and camera's current up
    _right.crossVectors(_forward, camera.up).normalize();
    if (_right.lengthSq() < 0.0001) {
        console.warn("Pitch Rotation: Could not calculate valid right vector (forward and up might be parallel).");
        return false; // Avoid rotation if right vector is invalid
    }

    // 2. Get the current view offset vector (from camera to target)
    _viewOffset.copy(controls.target).sub(camera.position);
    const originalViewOffsetLength = _viewOffset.length(); // Store original length

    // --- 3. Pitch Limit Check (Before applying rotation) ---
    // Calculate the angle between the current view direction and the world up vector
    const currentAngleWithWorldUp = _viewOffset.angleTo(_worldUp);
    const minPitchAngle = 0.05; // Radians: Approx 3 degrees from straight up/down poles
    const maxPitchAngle = Math.PI - minPitchAngle; // Limit near the opposite pole

    // Create the rotation quaternion for the proposed pitch change
    _qRotateView.setFromAxisAngle(_right, angle); // Rotate around the camera's local right axis

    // Predict the view offset after rotation
    const predictedViewOffset = _viewOffset.clone().applyQuaternion(_qRotateView);
    const predictedAngleWithWorldUp = predictedViewOffset.angleTo(_worldUp);

    // Check if the predicted angle exceeds limits
    let clampedAngle = angle; // Start with the requested angle
    if (angle < 0 && predictedAngleWithWorldUp < minPitchAngle) { // Trying to look further up than allowed
        console.log("Pitch limit reached (up). Clamping.");
        // Calculate the angle needed to *reach* the limit exactly
        const currentAngleToLimit = minPitchAngle - currentAngleWithWorldUp; // Negative value
        // Clamp the rotation angle (use max to get the smaller negative value, closer to 0)
        clampedAngle = Math.max(angle, currentAngleToLimit * 1.05); // Add slight buffer to ensure limit is met
        // Recreate the quaternion with the clamped angle
        _qRotateView.setFromAxisAngle(_right, clampedAngle);

    } else if (angle > 0 && predictedAngleWithWorldUp > maxPitchAngle) { // Trying to look further down than allowed
        console.log("Pitch limit reached (down). Clamping.");
        // Calculate the angle needed to *reach* the limit exactly
        const currentAngleToLimit = maxPitchAngle - currentAngleWithWorldUp; // Positive value
        // Clamp the rotation angle (use min to get the smaller positive value)
        clampedAngle = Math.min(angle, currentAngleToLimit * 1.05); // Add slight buffer
        // Recreate the quaternion with the clamped angle
        _qRotateView.setFromAxisAngle(_right, clampedAngle);
    }
    // --- End Pitch Limit Check ---

    // 4. Apply the (potentially clamped) rotation to the original view offset
    _viewOffset.applyQuaternion(_qRotateView);

    // Optional: Restore original length in case quaternion application slightly changed it
    if (Math.abs(_viewOffset.length() - originalViewOffsetLength) > 0.001) {
        _viewOffset.setLength(originalViewOffsetLength);
    }

    // 5. Calculate the new target position
    _newTargetPos.copy(camera.position).add(_viewOffset);

    // 6. Update ONLY the controls target
    controls.target.copy(_newTargetPos);

    // 7. Explicitly keep camera.up aligned with world up to prevent roll
    // This helps OrbitControls maintain the correct orientation during its update.
    camera.up.copy(defaultCameraUp);
    // --- End Rotation Logic ---

    return true; // Rotation happened (even if clamped)
}


// This function performs ORBITAL rotation (camera moves around modelCenter).
// It's kept here for reference but not currently used by Z/C keys (which now do view rotation).
function handleManualRotationFixedAxis(delta) {
    if (!camera || !controls || !currentMesh) return false; // Need prerequisites

    // Calculate rotation angle
    const rotationAngle = ROTATION_SPEED * delta * (keysPressed['shift'] ? BOOST_FACTOR : 1);
    let angle = 0;
    if (keysPressed['z']) angle = rotationAngle;       // Orbit left
    else if (keysPressed['c']) angle = -rotationAngle;  // Orbit right
    else return false; // No orbital rotation keys pressed

    // Define the pivot point for orbiting (usually the model center)
    const pivotPoint = modelCenter.clone();
    if (pivotPoint.lengthSq() < 0.0001 && currentMesh) {
        // If modelCenter is at origin, try calculating from bounding box again
        const box = new THREE.Box3().setFromObject(currentMesh);
        if (!box.isEmpty()) box.getCenter(pivotPoint);
        console.warn("Orbital Rotation: Model center was near origin, recalculated pivot.");
    }

    // --- Orbital Rotation Logic ---
    // 1. Calculate vector from pivot to camera
    _offsetFixedOrbit.copy(camera.position).sub(pivotPoint);

    // 2. Create rotation quaternion around the world up axis
    _qFixedOrbit.setFromAxisAngle(_worldUp, angle);

    // 3. Apply rotation to the offset vector
    _offsetFixedOrbit.applyQuaternion(_qFixedOrbit);

    // 4. Calculate new camera position by adding rotated offset back to pivot
    const newPosition = pivotPoint.clone().add(_offsetFixedOrbit);

    // 5. Sanity check new position
    if (![newPosition.x, newPosition.y, newPosition.z].every(Number.isFinite)) {
        console.warn("Orbital Rotation resulted in invalid camera position.");
        return false;
    }

    // 6. Apply changes
    controls.target.copy(pivotPoint); // Target must be the pivot point for orbit
    camera.position.copy(newPosition); // Move the camera
    camera.up.copy(defaultCameraUp); // Maintain world up

    // Let controls.update() handle the final lookAt orientation in the animate loop
    // --- End Orbital Rotation Logic ---

    return true; // Orbital rotation happened
}


function focusOnSelectedObject() {
    console.log("Focus (F) key pressed.");
    if (!selectedInstance || !selectedInstance.id) {
        console.warn("Focus: No instance selected.");
        showError("请先选择一个实例再按 F 键聚焦。");
        return;
    }

    const instanceIdStr = selectedInstance.id;
    let boxToFocus = new THREE.Box3(); // Box to calculate focus from
    let foundBox = false;

    // --- Strategy: Prioritize BBox data for focusing ---
    // 1. Try the temporary bbox helper (if highlight is active)
    if (currentTemporaryBBoxHelper?.box && !currentTemporaryBBoxHelper.box.isEmpty()) {
        boxToFocus.copy(currentTemporaryBBoxHelper.box);
        foundBox = true;
        console.log(`Focus: Using temporary bbox helper for instance ${instanceIdStr}.`);
    }
    // 2. Try the persistent bbox helper (if annotation was saved and has bbox)
    else if (persistentVisuals[instanceIdStr]?.bbox?.box && !persistentVisuals[instanceIdStr].bbox.box.isEmpty()) {
        boxToFocus.copy(persistentVisuals[instanceIdStr].bbox.box);
        foundBox = true;
        console.log(`Focus: Using persistent bbox helper for instance ${instanceIdStr}.`);
    }
    // 3. Fallback: Try the bounding box stored on selectedInstance (calculated during highlight)
    else if (selectedInstance.boundingBox) {
        try {
            const bbData = selectedInstance.boundingBox;
            if (bbData.min && bbData.max) {
                const minVec = new THREE.Vector3(bbData.min.x, bbData.min.y, bbData.min.z);
                const maxVec = new THREE.Vector3(bbData.max.x, bbData.max.y, bbData.max.z);
                boxToFocus.set(minVec, maxVec);
                if (!boxToFocus.isEmpty()) {
                    foundBox = true;
                    console.log(`Focus: Using bounding box data stored on selectedInstance ${instanceIdStr}.`);
                }
            }
        } catch (e) {
            console.error("Focus: Error constructing box from selectedInstance.boundingBox:", e);
        }
    }
        // 4. Final Fallback: Recalculate from the highlight mesh geometry (if highlight is active)
    // This is less ideal as it involves recomputing.
    else if (currentHighlightMesh?.geometry) {
        try {
            currentHighlightMesh.geometry.computeBoundingBox();
            if (currentHighlightMesh.geometry.boundingBox && !currentHighlightMesh.geometry.boundingBox.isEmpty()) {
                boxToFocus.copy(currentHighlightMesh.geometry.boundingBox);
                foundBox = true;
                console.log(`Focus: Using highlight mesh geometry bounding box for instance ${instanceIdStr}.`);
            }
        } catch (e) {
            console.error("Focus: Error computing highlight mesh bounding box:", e);
        }
    }

    // --- Apply Focus ---
    if (!foundBox || boxToFocus.isEmpty()) {
        console.warn(`Focus: Could not find or calculate a valid bounding box for the selected instance ${instanceIdStr}. Cannot focus.`);
        showError(`无法计算实例 ${instanceIdStr} 的边界框以进行聚焦。`);
        return;
    }

    // Use the standard fitCameraToObject logic, but with the derived box
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    boxToFocus.getCenter(center);
    boxToFocus.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);

    if (maxDim <= 0) {
        console.warn("Focus: Target bounding box has zero dimensions.");
        // Just move target to center?
        controls.target.copy(center);
        controls.update();
        return;
    }

    // Calculate distance (similar to fitCameraToObject)
    const fov = camera.fov * (Math.PI / 180);
    const fitOffset = maxDim / (2 * Math.tan(fov / 2));
    const distance = fitOffset * 1.8; // Adjust focus distance multiplier (e.g., 1.8 is a bit closer than full fit)

    // Maintain current viewing direction
    const direction = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
    if (direction.lengthSq() < 0.0001) {
        direction.set(0, -0.3, 1).normalize(); // Default direction if camera is at target
    }

    // Calculate new camera position
    const newCameraPosition = center.clone().addScaledVector(direction, distance);

    // Sanity check
    if ([center.x, center.y, center.z, newCameraPosition.x, newCameraPosition.y, newCameraPosition.z, distance].every(Number.isFinite)) {
        // Apply focus smoothly (optional, needs tweening library) or instantly
        // Instant focus:
        controls.target.copy(center);
        camera.position.copy(newCameraPosition);

        // Update near/far planes
        camera.near = Math.max(0.01, distance / 1000);
        camera.far = distance * 10;
        if (camera.near >= camera.far) camera.far = camera.near + 100;
        camera.updateProjectionMatrix();

        controls.update(); // Force update
        console.log(`Focus applied. Target set to instance ${instanceIdStr} center: [${center.x.toFixed(2)},${center.y.toFixed(2)},${center.z.toFixed(2)}]`);
    } else {
        console.warn("Focus: Invalid calculated position/target.");
    }
}

// --- Start Everything ---
document.addEventListener('DOMContentLoaded', init);
// --- END OF FILE main.js ---