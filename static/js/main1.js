// --- START OF FILE main.js ---

// --- Imports ---
// Assumes Three.js, OrbitControls, GLTFLoader are loaded via <script> tags in index.html

// --- Global Variables ---
let scene, camera, renderer, controls;
let currentSceneRoot = null; // The root THREE.Object3D loaded from GLB
let currentMesh = null; // Often the same as currentSceneRoot or its primary child mesh group
let currentSceneId = null; // ID of the currently loaded scene (e.g., '17DRP5sb8fy')

// --- NEW: Global variables for split data ---
let instanceDetails = {}; // Stores { instanceId: { label, category_id, region_label, region_code } } loaded from _details.json
let faceMapArray = null; // Stores Int32Array mapping faceIndex -> instanceId (-1 if no instance), loaded from _face_map.bin
// --- END NEW ---

let selectedInstance = null; // Holds confirmed selection data: { id, label, categoryId, regionLabel, regionCode, boundingBox }
let currentHighlightMesh = null; // THREE.Mesh used to highlight the selected instance
let raycaster; // THREE.Raycaster for picking
let mouse; // THREE.Vector2 for mouse coordinates
let fetchController = null; // AbortController for fetch requests
let gltfLoader; // THREE.GLTFLoader instance
let modelCenter = new THREE.Vector3(0, 0, 0); // Center of the loaded model, used for some camera controls

// --- Visualization and Saved Data Management ---
let currentTemporaryMarker = null;         // THREE.Mesh marker shown on initial click
let currentTemporaryBBoxHelper = null;   // THREE.Box3Helper shown on confirmation/highlight (before save)
let persistentVisuals = {};              // Stores saved { marker: THREE.Mesh, bbox: THREE.Box3Helper } keyed by instance_id (string)
let savedAnnotationsData = {};           // Stores loaded/saved { finalLabel, query, boundingBox } keyed by instance_id (string), loaded from backend
const MAX_PERSISTENT_MARKERS = 200;      // Optional: Limit persistent markers per scene to prevent clutter

// --- Colors for Visualization ---
const TEMP_MARKER_COLOR = 0xff0000;     // Red for temporary click marker
const TEMP_BBOX_COLOR = 0xff0000;       // Red for temporary bbox on highlight/confirm
const PERSISTENT_MARKER_COLOR = 0x00cc00; // Green for saved annotation marker
const PERSISTENT_BBOX_COLOR = 0x00cc00;   // Green for saved annotation bbox

// --- Confirmation State Variables (used between click and confirm) ---
let pendingInstanceId = null;
let pendingLabel = null;
let pendingCategoryId = null;
let pendingRegionLabel = null;
let pendingRegionCode = null;

// --- Enhanced View Control Variables ---
let clock; // THREE.Clock for delta time calculation
let keysPressed = {}; // Tracks currently pressed keys for movement/rotation
const MOVEMENT_SPEED = 3.0; // Units per second for WASDQE movement
const ROTATION_SPEED = 1.5; // Radians per second for Z/C/V/B rotation
const BOOST_FACTOR = 3.0; // Speed multiplier when Shift is held
const _worldUp = new THREE.Vector3(0, 0, 1); // Define World Z-axis as Up (adjust if your coordinate system is different)
let defaultCameraUp = _worldUp.clone();      // Default camera up vector aligns with world up
// Temporary vectors/quaternions to avoid allocation in loops
const _qFixedOrbit = new THREE.Quaternion();
const _offsetFixedOrbit = new THREE.Vector3();
const _qRotateView = new THREE.Quaternion();
const _viewOffset = new THREE.Vector3();
const _newTargetPos = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();

// --- DOM Elements ---
let sceneSelector, loadSceneButton, viewerContainer, infoDiv, queryInput, saveButton,
    annotationSection, saveStatusDiv, loadingStatusDiv, errorStatusDiv,
    confirmationSection, pendingInstanceIdSpan, pendingCategoryIdSpan, pendingLabelSpan,
    pendingRegionLabelSpan, pendingRegionCodeSpan,
    labelModifyInput, confirmButton, cancelButton,
    existingAnnotationInfoP,
    viewModeToggle, presetViewButtons;

// --- Utility Functions ---
function showLoading(isLoading, message = "Loading...") {
    if (loadingStatusDiv) {
        loadingStatusDiv.textContent = message;
        loadingStatusDiv.style.display = isLoading ? 'block' : 'none';
    }
    if (loadSceneButton) {
        loadSceneButton.disabled = !!isLoading; // Disable button while loading
    }
    if (sceneSelector) {
        sceneSelector.disabled = !!isLoading; // Disable selector while loading
    }
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
    // Clear status after a delay
    setTimeout(() => {
        // Check if the message is still the same before clearing
        if (saveStatusDiv && saveStatusDiv.textContent === message) {
            saveStatusDiv.textContent = "";
        }
    }, isError ? 6000 : 4000); // Longer display for errors
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
    // Remove the yellow highlight mesh
    if (currentHighlightMesh) {
        scene?.remove(currentHighlightMesh);
        currentHighlightMesh.geometry?.dispose();
        // Material might be an array, handle both cases
        (Array.isArray(currentHighlightMesh.material) ? currentHighlightMesh.material : [currentHighlightMesh.material]).forEach(m => m?.dispose());
        currentHighlightMesh = null;
    }
    // Also clear the temporary red bbox helper associated with the highlight/confirmation phase
    clearTemporaryBBoxHelper();
}

function clearAllPersistentVisuals() {
    console.log(`Clearing ${Object.keys(persistentVisuals).length} persistent visuals.`);
    for (const instanceId in persistentVisuals) {
        if (Object.prototype.hasOwnProperty.call(persistentVisuals, instanceId)) {
            const visuals = persistentVisuals[instanceId];
            if (visuals?.marker?.parent === scene) {
                scene.remove(visuals.marker);
                visuals.marker.geometry?.dispose();
                visuals.marker.material?.dispose();
            }
            if (visuals?.bbox?.parent === scene) {
                scene.remove(visuals.bbox);
                visuals.bbox.geometry?.dispose();
                visuals.bbox.material?.dispose();
            }
        }
    }
    persistentVisuals = {}; // Reset the tracker object
}

// --- Animation loop ---
function animate() {
    requestAnimationFrame(animate); // Schedule next frame
    let delta = clock ? clock.getDelta() : 0; // Time since last frame

    try {
        // Handle keyboard input for camera movement and rotation
        if (controls && camera && typeof handleKeyboardInput === 'function') {
            handleKeyboardInput(delta);
        }

        // Update OrbitControls (applies damping, target changes from keyboard input)
        if (controls?.update) {
            controls.update(delta); // Pass delta for damping calculation
        }
    } catch (updateError) {
        console.error("Error during controls update:", updateError);
        // Consider adding UI feedback for critical errors
    }

    // Render the scene
    if (renderer && scene && camera) {
        try {
            renderer.render(scene, camera);
        } catch (renderError) {
            console.error("Error during rendering:", renderError);
            // Potentially stop animation loop on critical render errors
        }
    }
}

// --- Window Resize Handler ---
function onWindowResize() {
    if (camera && renderer && viewerContainer) {
        // Update camera aspect ratio
        camera.aspect = viewerContainer.clientWidth / viewerContainer.clientHeight;
        camera.updateProjectionMatrix();

        // Update renderer size
        renderer.setSize(viewerContainer.clientWidth, viewerContainer.clientHeight);
        // Note: No need to redraw explicitly here, `animate` loop handles rendering
    }
}

// --- Camera Fitting ---
function fitCameraToObject(object, offset = 1.5) {
    if (!(object instanceof THREE.Object3D) || !camera || !controls) {
        console.warn("fitCameraToObject: prerequisites not met (object, camera, controls).");
        return;
    }

    const boundingBox = new THREE.Box3();
    try {
        // Ensure world matrix is up-to-date before calculating bounds
        object.updateMatrixWorld(true);
        // Calculate axis-aligned bounding box in world space, considering children
        boundingBox.setFromObject(object, true);
    } catch (e) {
        console.error("Error calculating bounding box for fitCameraToObject:", e);
        return; // Abort if bbox calculation fails
    }

    // Check if the bounding box is valid
    if (boundingBox.isEmpty()) {
        console.warn("fitCameraToObject: Bounding box is empty. Cannot fit.");
        // Optionally reset camera to a default view
        // camera.position.set(0, -3, 3);
        // controls.target.set(0, 0, 0);
        // controls.update();
        return;
    }

    const center = new THREE.Vector3();
    boundingBox.getCenter(center);
    modelCenter.copy(center); // Store the center globally if needed elsewhere

    const size = new THREE.Vector3();
    boundingBox.getSize(size);

    // Handle cases where model might be flat or very small
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim <= 0) {
        console.warn("fitCameraToObject: Model has zero or negative dimensions.");
        // Use center as target, place camera nearby
        controls.target.copy(center);
        camera.position.copy(center).add(new THREE.Vector3(0, -1, 1)); // Example fallback position
        camera.near = 0.01;
        camera.far = 100;
        camera.up.copy(defaultCameraUp);
        camera.updateProjectionMatrix();
        controls.update();
        return;
    }

    // Calculate distance needed to fit the object based on FOV
    const fov = camera.fov * (Math.PI / 180);
    let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
    cameraZ *= offset; // Apply the offset multiplier

    // Maintain the current camera viewing direction if possible
    const direction = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
    // If direction is zero (camera at target), provide a default direction
    if (direction.lengthSq() < 0.0001) {
        direction.set(0, -0.3, 1).normalize(); // Example: Look from slightly behind and above (relative to Z-up world)
    }

    // Calculate the new camera position
    const newCameraPosition = new THREE.Vector3().copy(center).addScaledVector(direction, cameraZ);

    // Sanity check calculated values
    if (![center.x, center.y, center.z, newCameraPosition.x, newCameraPosition.y, newCameraPosition.z, cameraZ].every(Number.isFinite)) {
        console.error("fitCameraToObject: Invalid numbers calculated for position or target. Aborting fit.");
        return;
    }

    // Apply the new target and position
    controls.target.copy(center);
    camera.position.copy(newCameraPosition);

    // Adjust near/far clipping planes for the new distance
    // Ensure near is not too small or larger than far
    camera.near = Math.max(0.01, cameraZ / 1000);
    camera.far = cameraZ * 10; // Adjust multiplier as needed
    if (camera.near >= camera.far) {
        camera.far = camera.near + 100; // Ensure far > near
    }


    // Ensure camera's UP vector is correctly set before updating controls/matrix
    camera.up.copy(defaultCameraUp); // Use the default up vector (e.g., Z-up)

    camera.updateProjectionMatrix();

    // Let OrbitControls handle the final lookAt during its update cycle
    controls.update(); // Force an update to apply changes immediately

    console.log(`fitCameraToObject Ran. Target: [${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)}]`);
}

// --- Marker and BBox Functions ---

// Creates a *temporary* debug marker (red sphere) at a position
function addTemporaryDebugMarker(position) {
    clearTemporaryMarker(); // Remove any existing temporary marker first
    if (!position || !scene) return;

    try {
        // Small sphere geometry
        const geometry = new THREE.SphereGeometry(0.03, 16, 8); // Adjust size as needed
        // Basic red material, ignore depth test to make it visible through objects
        const material = new THREE.MeshBasicMaterial({ color: TEMP_MARKER_COLOR, depthTest: false });
        currentTemporaryMarker = new THREE.Mesh(geometry, material);
        currentTemporaryMarker.position.copy(position);
        currentTemporaryMarker.renderOrder = 2; // Render on top of highlight mesh
        scene.add(currentTemporaryMarker);
    } catch (e) {
        console.error("Error creating debug marker:", e);
    }
}

// Creates a *persistent* marker (green sphere)
function addPersistentMarker(position, instanceId) {
    if (!position || !scene || !instanceId) return null; // Need position, scene, and ID

    try {
        const geometry = new THREE.SphereGeometry(0.04, 16, 8); // Slightly larger than temp marker
        const material = new THREE.MeshBasicMaterial({ color: PERSISTENT_MARKER_COLOR, depthTest: false });
        const marker = new THREE.Mesh(geometry, material);
        marker.position.copy(position);
        marker.renderOrder = 2; // Render on top of highlight mesh
        scene.add(marker);
        return marker; // Return the created marker object
    } catch (e) {
        console.error(`Error creating persistent marker for instance ${instanceId}:`, e);
        return null;
    }
}

// Creates a *persistent* BBox helper (green wireframe box)
function addPersistentBBoxHelper(box3, instanceId) {
    if (!box3 || !(box3 instanceof THREE.Box3) || box3.isEmpty() || !scene || !instanceId) return null;

    try {
        const helper = new THREE.Box3Helper(box3, PERSISTENT_BBOX_COLOR);
        helper.renderOrder = 1; // Render potentially behind markers
        scene.add(helper);
        return helper; // Return the created helper object
    } catch (e) {
        console.error(`Error creating persistent bbox helper for instance ${instanceId}:`, e);
        return null;
    }
}

// --- UI State Functions ---
function hideConfirmationPrompt() {
    if (confirmationSection) confirmationSection.style.display = 'none';
    if (existingAnnotationInfoP) existingAnnotationInfoP.style.display = 'none'; // Hide existing annotation info too

    // Clear pending state variables
    pendingInstanceId = null;
    pendingLabel = null;
    pendingCategoryId = null;
    pendingRegionLabel = null;
    pendingRegionCode = null;

    // Clear display elements in the confirmation section
    if (pendingInstanceIdSpan) pendingInstanceIdSpan.textContent = '';
    if (pendingCategoryIdSpan) pendingCategoryIdSpan.textContent = '';
    if (pendingLabelSpan) pendingLabelSpan.textContent = '';
    if (pendingRegionLabelSpan) pendingRegionLabelSpan.textContent = 'N/A';
    if (pendingRegionCodeSpan) pendingRegionCodeSpan.textContent = '-';
}

function resetAnnotationState() {
    // Reset core selection state
    selectedInstance = null;

    // Clear visual feedback
    clearHighlight(); // Removes yellow highlight mesh and temp bbox
    clearTemporaryMarker(); // Removes red click marker
    clearAllPersistentVisuals(); // Removes all green saved markers/bboxes

    // Reset data stores
    savedAnnotationsData = {}; // Clear cache of saved annotations

    // --- NEW: Reset new globals specific to the loaded scene ---
    instanceDetails = {}; // Clear the details map
    faceMapArray = null; // Clear the face map array
    // --- END NEW ---

    // Reset UI elements in the annotation panel
    if (infoDiv) infoDiv.textContent = 'Selected: None';
    if (labelModifyInput) labelModifyInput.value = '';
    if (queryInput) queryInput.value = '';
    if (saveButton) saveButton.disabled = true; // Disable save until selection is confirmed
    if (annotationSection) annotationSection.style.display = 'none'; // Hide annotation section
    if (saveStatusDiv) saveStatusDiv.textContent = ''; // Clear save status message

    // Ensure confirmation prompt is hidden
    hideConfirmationPrompt();
}

// --- Initialization ---
function init() {
    console.log("Initializing application...");
    try {
        // Get DOM Elements
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
        presetViewButtons = {
            top: document.getElementById('presetTopBtn'),
            bottom: document.getElementById('presetBottomBtn'),
            front: document.getElementById('presetFrontBtn'),
            back: document.getElementById('presetBackBtn'),
            left: document.getElementById('presetLeftBtn'),
            right: document.getElementById('presetRightBtn')
        };

        // Critical element check
        const criticalElements = {
            viewerContainer, sceneSelector, loadSceneButton, confirmationSection,
            confirmButton, cancelButton, pendingInstanceIdSpan, pendingCategoryIdSpan,
            pendingLabelSpan, pendingRegionLabelSpan, pendingRegionCodeSpan,
            annotationSection, infoDiv, labelModifyInput, queryInput, saveButton,
            existingAnnotationInfoP, viewModeToggle, ...Object.values(presetViewButtons).filter(Boolean)
        };
        let missing = [];
        for (const [name, element] of Object.entries(criticalElements)) {
            if (!element) missing.push(name);
        }
        if (missing.length > 0) {
            throw new Error(`CRITICAL: Missing DOM element(s): ${missing.join(', ')}.`);
        }
        console.log("All critical DOM elements found.");

        // Basic Three.js setup
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0xcccccc); // Light grey background

        camera = new THREE.PerspectiveCamera(
            75, // Field of View (degrees)
            viewerContainer.clientWidth / viewerContainer.clientHeight, // Aspect Ratio
            0.1, // Near clipping plane
            1000 // Far clipping plane
        );
        camera.position.set(0, -3, 3); // Initial camera position (adjust as needed)
        camera.up.copy(defaultCameraUp); // Set initial up vector (Z-up)

        renderer = new THREE.WebGLRenderer({
            antialias: true, // Enable anti-aliasing for smoother edges
            // Optional: preserveDrawingBuffer: true // if you need to take screenshots
        });
        renderer.setPixelRatio(window.devicePixelRatio); // Adjust for high-DPI displays
        renderer.setSize(viewerContainer.clientWidth, viewerContainer.clientHeight);
        renderer.toneMapping = THREE.ACESFilmicToneMapping; // Use filmic tone mapping for better contrast/color
        renderer.outputEncoding = THREE.sRGBEncoding; // Use sRGB for color space consistency
        viewerContainer.appendChild(renderer.domElement); // Add the renderer's canvas to the DOM
        console.log("Renderer initialized.");

        // OrbitControls setup
        if (typeof THREE.OrbitControls === 'undefined') {
            throw new Error("OrbitControls library not found. Make sure it's included in index.html.");
        }
        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true; // Enable smooth camera inertia
        controls.dampingFactor = 0.1; // Adjust damping intensity
        controls.screenSpacePanning = true; // Allow panning across the screen plane
        controls.target.set(0, 0, 0); // Initial focus point
        // Optional: Limit zoom/pan/rotation if needed
        // controls.minDistance = 0.5;
        // controls.maxDistance = 50;
        // controls.maxPolarAngle = Math.PI / 2; // Prevent looking straight down from top
        console.log("OrbitControls initialized.");

        // Raycaster and Mouse Vector setup
        raycaster = new THREE.Raycaster();
        mouse = new THREE.Vector2(); // Stores normalized mouse coordinates (-1 to +1)
        console.log("Raycaster initialized.");

        // Lighting setup
        scene.add(new THREE.AmbientLight(0xffffff, 0.6)); // Soft ambient light
        const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.7); // Main directional light
        dirLight1.position.set(5, -10, 7.5); // Position the light
        scene.add(dirLight1);
        const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.4); // Secondary fill light
        dirLight2.position.set(-5, 10, -5);
        scene.add(dirLight2);
        const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5); // Sky/ground light
        hemiLight.position.set(0, 0, 20);
        scene.add(hemiLight);
        console.log("Lights added.");

        // GLTF Loader setup
        if (typeof THREE.GLTFLoader !== 'function') {
            throw new Error("GLTFLoader library not found. Make sure it's included in index.html.");
        }
        gltfLoader = new THREE.GLTFLoader();
        console.log("GLTFLoader initialized.");

        // Clock setup
        clock = new THREE.Clock(); // For timing in the animation loop
        console.log("Clock initialized.");

        // Event Listeners setup
        loadSceneButton.addEventListener('click', loadSelectedScene);
        viewerContainer.addEventListener('pointerdown', onPointerDown, false); // Use pointerdown for better compatibility
        saveButton.addEventListener('click', saveAnnotation);
        confirmButton.addEventListener('click', handleConfirmSelection);
        cancelButton.addEventListener('click', handleCancelSelection);
        viewModeToggle.addEventListener('change', handleViewModeChange);
        window.addEventListener('resize', onWindowResize); // Handle browser window resizing

        // Preset view button listeners
        for (const [viewType, button] of Object.entries(presetViewButtons)) {
            if (button) {
                // Use closure to capture the correct viewType for each listener
                button.addEventListener('click', ((type) => () => setPresetView(type))(viewType));
            }
        }

        // Keyboard listeners for camera control
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        console.log("Event listeners added.");

        // Start the animation loop
        animate();
        console.log("Initialization finished successfully. Starting animation loop.");

    } catch (error) {
        console.error("FATAL ERROR during initialization:", error);
        // Display error prominently to the user if initialization fails
        const body = document.body;
        if (body) {
            const errorDiv = document.createElement('div');
            errorDiv.style.cssText = `position: fixed; top: 10px; left: 10px; right: 10px; padding: 20px; background-color: #dc3545; color: white; z-index: 10000; border: 2px solid darkred; border-radius: 5px; font-family: sans-serif; font-size: 1.1em;`;
            errorDiv.innerHTML = `<strong>Application Initialization Failed:</strong><br>${error.message}<br>Please check the browser console (F12) for more details and report the issue.`;
            body.appendChild(errorDiv);
        }
        // Also use the standard error display if available
        if (typeof showError === 'function') {
            showError(`Application Initialization Failed: ${error.message}`);
        }
        // Disable interaction if init failed
        if (loadSceneButton) loadSceneButton.disabled = true;
        if (sceneSelector) sceneSelector.disabled = true;
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
    showError(null); // Clear previous errors
    clearScene(); // Reset everything from the previous scene

    // Abort previous fetch if ongoing
    if (fetchController) {
        fetchController.abort();
        console.log("Aborted previous scene load request.");
    }
    fetchController = new AbortController();
    const signal = fetchController.signal;

    // Fetch scene metadata (URLs) from the backend
    fetch(`/load_scene/${selectedSceneId}`, { signal })
        .then(response => {
            if (signal.aborted) throw new Error('Fetch aborted'); // Check if aborted during fetch
            if (!response.ok) {
                // Try to get error message from backend JSON response
                return response.json().catch(() => ({})).then(errData => {
                   throw new Error(errData.description || `Server error loading scene info: ${response.status}`);
                });
            }
            return response.json(); // Parse the successful JSON response
        })
        .then(data => {
            if (signal.aborted) throw new Error('Fetch aborted'); // Check if aborted after fetch
            // --- UPDATED: Check for new URLs ---
            if (data.status !== 'success' || !data.glb_url || !data.details_url || !data.face_map_url) {
                throw new Error(data.message || "Invalid data format from server (missing URLs).");
            }
            console.log(`Received URLs: GLB=${data.glb_url}, Details=${data.details_url}, FaceMap=${data.face_map_url}`);
            // --- END UPDATED ---

            // Load existing annotations data
            if (data.existing_annotations && typeof data.existing_annotations === 'object') {
                savedAnnotationsData = data.existing_annotations;
                console.log(`Received ${Object.keys(savedAnnotationsData).length} existing annotations.`);
            } else {
                savedAnnotationsData = {}; // Ensure it's an empty object if none received
                console.log("No existing annotations received or invalid format.");
            }

            // --- UPDATED: Fetch GLB, Details JSON, and Face Map Binary in parallel ---
            showLoading(true, "Loading model, details, and map...");
            console.time(`Scene ${selectedSceneId} Asset Download`); // Start timing asset download
            return Promise.all([
                loadGLBModel(data.glb_url, signal), // Fetch and parse GLB
                fetch(data.details_url, { signal }).then(res => { // Fetch details JSON
                    if (signal.aborted) throw new Error('Fetch aborted');
                    if (!res.ok) throw new Error(`Failed to load instance details: ${res.status}`);
                    showLoading(true, "Loading details...");
                    return res.json();
                }),
                fetch(data.face_map_url, { signal }).then(res => { // Fetch face map BINARY
                    if (signal.aborted) throw new Error('Fetch aborted');
                    if (!res.ok) throw new Error(`Failed to load face map: ${res.status}`);
                    showLoading(true, "Loading face map...");
                    return res.arrayBuffer(); // Fetch as ArrayBuffer
                })
            ]);
            // --- END UPDATED ---
        })
        // --- UPDATED: Process the results from Promise.all ---
        .then(([loadedMesh, loadedDetails, faceMapBuffer]) => {
            console.timeEnd(`Scene ${selectedSceneId} Asset Download`); // End timing asset download
            if (signal.aborted) throw new Error('Fetch aborted'); // Check if aborted after downloads

            if (!(loadedMesh instanceof THREE.Object3D)) {
                throw new Error("Failed to get a valid 3D object from GLB loader.");
            }

            currentMesh = loadedMesh; // Store the loaded mesh group
            instanceDetails = loadedDetails; // Store the instance details object

            // --- Convert ArrayBuffer to Int32Array (must match Python FACE_MAP_DTYPE) ---
            try {
                 console.log(`Received face map buffer: ${faceMapBuffer.byteLength} bytes`);
                 if (faceMapBuffer.byteLength % 4 !== 0) {
                     console.warn(`Face map buffer size (${faceMapBuffer.byteLength}) is not a multiple of 4 bytes. Potential mismatch with Int32.`);
                 }
                 // Create the typed array. This is a view onto the ArrayBuffer.
                 faceMapArray = new Int32Array(faceMapBuffer);
            } catch (e) {
                 console.error("Error creating Int32Array from face map buffer:", e);
                 throw new Error("Failed to process face map data. Check format and type.");
            }
            // --- End Conversion ---

            console.log(`Loaded ${Object.keys(instanceDetails).length} unique instance details.`);
            console.log(`Loaded face map with ${faceMapArray.length} face entries.`);
            if (faceMapArray.length === 0) {
                 console.warn("Face map array is empty! This might indicate an issue during processing or an empty mesh.");
            }

            currentSceneId = selectedSceneId; // Store the ID of the loaded scene
            scene.add(currentMesh); // Add the loaded model to the Three.js scene
            console.log(`Scene ${selectedSceneId} model added to scene graph.`);

            displayExistingAnnotations(); // Visualize annotations loaded earlier
            fitCameraToObject(currentMesh, 1.8); // Adjust camera to view the model

            showLoading(false); // Hide loading indicator
            fetchController = null; // Clear fetch controller
            console.log(`Scene ${selectedSceneId} loading complete.`);

        })
        // --- END UPDATED ---
        .catch(error => {
            // Handle errors during the loading process
            if (error.name === 'AbortError' || error.message === 'Fetch aborted') {
                console.log(`Scene loading for ${selectedSceneId} was intentionally aborted.`);
                // No need to show error message for user-initiated aborts
            } else {
                console.error(`Error loading scene ${selectedSceneId}:`, error);
                showError(`加载场景 ${selectedSceneId} 失败: ${error.message}`);
                clearScene(); // Ensure scene is cleared on error
            }
            showLoading(false); // Hide loading indicator
            fetchController = null; // Clear fetch controller
        });
}

function displayExistingAnnotations() {
    if (!scene) {
        console.warn("Cannot display annotations: Scene not available.");
        return;
    }
    console.log(`Attempting to display ${Object.keys(savedAnnotationsData).length} loaded annotations.`);
    clearAllPersistentVisuals(); // Clear any visuals from previous scenes/loads

    let displayedCount = 0;
    let skippedCount = 0;
    const instanceIdsToDisplay = Object.keys(savedAnnotationsData);

    for (const instanceId of instanceIdsToDisplay) {
        if (Object.prototype.hasOwnProperty.call(savedAnnotationsData, instanceId)) {
            const annotation = savedAnnotationsData[instanceId];

            // Check if we have bounding box data for visualization
            if (annotation?.boundingBox) {
                try {
                    const bbData = annotation.boundingBox;
                    // Basic validation of bbox data structure
                    if (bbData.min && bbData.max &&
                        typeof bbData.min.x === 'number' && typeof bbData.min.y === 'number' && typeof bbData.min.z === 'number' &&
                        typeof bbData.max.x === 'number' && typeof bbData.max.y === 'number' && typeof bbData.max.z === 'number')
                    {
                        const minVec = new THREE.Vector3(bbData.min.x, bbData.min.y, bbData.min.z);
                        const maxVec = new THREE.Vector3(bbData.max.x, bbData.max.y, bbData.max.z);
                        const box = new THREE.Box3(minVec, maxVec);

                        if (!box.isEmpty()) {
                            // Optional: Limit number of persistent visuals
                            if (Object.keys(persistentVisuals).length >= MAX_PERSISTENT_MARKERS) {
                                console.warn(`Max persistent visuals (${MAX_PERSISTENT_MARKERS}) reached. Skipping further annotation display.`);
                                break; // Stop adding more visuals
                            }

                            // Create persistent visuals (marker at center + bbox helper)
                            const center = new THREE.Vector3();
                            box.getCenter(center);
                            const pMarker = addPersistentMarker(center, instanceId);
                            const pBbox = addPersistentBBoxHelper(box, instanceId);

                            // Store references to the created visuals
                            persistentVisuals[instanceId] = { marker: pMarker, bbox: pBbox };
                            displayedCount++;
                        } else {
                            console.warn(`Skipping visualization for instance ${instanceId}: Bounding box data is empty.`);
                            persistentVisuals[instanceId] = { marker: null, bbox: null }; // Mark as processed but no visual
                            skippedCount++;
                        }
                    } else {
                        console.warn(`Skipping visualization for instance ${instanceId}: Invalid bounding box data format.`);
                        persistentVisuals[instanceId] = { marker: null, bbox: null };
                        skippedCount++;
                    }
                } catch (error) {
                    console.error(`Error processing bounding box visualization for instance ${instanceId}:`, error);
                    persistentVisuals[instanceId] = { marker: null, bbox: null };
                    skippedCount++;
                }
            } else {
                // Annotation exists but has no bounding box data
                console.log(`Annotation for instance ${instanceId} has no bounding box data. Skipping visualization.`);
                persistentVisuals[instanceId] = { marker: null, bbox: null }; // Mark as processed
                skippedCount++;
            }
        }
    }
    console.log(`Displayed ${displayedCount} persistent visuals for annotations. Skipped ${skippedCount}.`);
}

function loadGLBModel(url, signal) {
    return new Promise((resolve, reject) => {
        if (!gltfLoader) {
            return reject(new Error("GLTFLoader is not initialized."));
        }

        console.log("Starting GLB model loading:", url);
        const startTime = performance.now();
        showLoading(true, "Loading 3D model..."); // General message initially

        gltfLoader.load(
            url,
            // --- onSuccess ---
            (gltf) => {
                const loadTime = ((performance.now() - startTime) / 1000).toFixed(2);
                console.log(`GLB model data received and parsed in ${loadTime} seconds.`);

                // Find the main scene object
                const sceneRoot = gltf.scene || (gltf.scenes && gltf.scenes.length > 0 ? gltf.scenes[0] : null);
                if (!(sceneRoot instanceof THREE.Object3D)) {
                    return reject(new Error("No valid 3D scene found in the loaded GLB file."));
                }
                console.log("Valid scene object found in GLB.");

                currentSceneRoot = sceneRoot; // Store reference if needed globally

                // --- Post-processing on loaded model (optional but recommended) ---
                sceneRoot.traverse(node => {
                    // Example: Ensure materials are set correctly for initial view
                    if (node.isMesh) {
                        const materials = Array.isArray(node.material) ? node.material : [node.material];
                        materials.forEach(mat => {
                            if (mat instanceof THREE.Material) {
                                // Set initial side based on default view mode (e.g., FrontSide)
                                mat.side = THREE.FrontSide; // View mode changer will handle other modes
                                // Optional: Force transparent objects to render correctly
                                // if (mat.transparent) {
                                //     mat.depthWrite = true; // Adjust based on visual needs
                                // }
                                mat.needsUpdate = true; // Ensure changes are applied
                            }
                        });
                    }
                    // Example: Cast shadows (if needed)
                    // node.castShadow = true;
                    // node.receiveShadow = true;
                });
                // --- End Post-processing ---

                resolve(sceneRoot); // Resolve the promise with the loaded scene object
            },
            // --- onProgress ---
            (xhr) => {
                if (signal?.aborted) {
                    // Don't update progress if aborted
                    return;
                }
                if (xhr.lengthComputable) {
                    const percentComplete = Math.round((xhr.loaded / xhr.total) * 100);
                    showLoading(true, `Loading 3D model: ${percentComplete}%`);
                } else {
                    // Show loaded size if total is unknown
                    showLoading(true, `Loading 3D model: ${Math.round(xhr.loaded / 1024 / 1024)} MB`);
                }
            },
            // --- onError ---
            (error) => {
                const loadTime = ((performance.now() - startTime) / 1000).toFixed(2);
                console.error(`Error loading GLB model after ${loadTime} seconds:`, error);

                // Check if the error is due to abortion
                if (signal?.aborted) {
                   reject(new Error('GLB model loading aborted.'));
                } else {
                   // Provide a more specific error message if possible
                   let errorMsg = `Failed to load GLB model: ${error.message || 'Unknown loader error'}`;
                   if (error.target?.status) { // Check for HTTP status if it's a network error
                       errorMsg += ` (Status: ${error.target.status})`;
                   }
                   reject(new Error(errorMsg));
                }
            }
        );

        // Handle abortion signal if provided
        if (signal) {
            signal.addEventListener('abort', () => {
                // Note: GLTFLoader doesn't have a direct abort method.
                // This mainly prevents resolving/rejecting the promise if already aborted.
                console.log("GLB load abort signal received.");
                reject(new Error('GLB model loading aborted.'));
            }, { once: true }); // Remove listener after first abort signal
        }
    });
}


function onPointerDown(event) {
    // --- UPDATED: Check for faceMapArray and instanceDetails ---
    if (!currentMesh || !camera || !raycaster || !viewerContainer || !faceMapArray || !instanceDetails) {
         console.warn("PointerDown prerequisites not met (mesh, camera, raycaster, container, faceMapArray, instanceDetails).");
         // Optionally provide user feedback if clicking is disabled
         // showError("场景数据尚未完全加载，请稍候再试。");
         return;
    }

    // Prevent triggering selection if interacting with UI elements over the viewer
    // This requires the UI elements not to be direct children capturing the event first.
    // A more robust solution might involve checking event.target.
    // if (event.target !== renderer.domElement) {
    //     return;
    // }

    clearTemporaryMarker(); // Clear previous click marker

    try {
        // Calculate normalized device coordinates (NDC) from mouse position
        const rect = viewerContainer.getBoundingClientRect(); // Get viewer bounds relative to viewport
        // Convert mouse coords from screen space to NDC space (-1 to +1)
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        // Update the raycaster with the camera and mouse position
        raycaster.setFromCamera(mouse, camera);

        // Perform the intersection test against the main mesh (recursive)
        // Note: Ensure `currentMesh` is the correct object containing all relevant sub-meshes
        const intersects = raycaster.intersectObject(currentMesh, true);

        if (intersects.length > 0) {
            // Intersection found, get the closest one
            const intersection = intersects[0];
            const faceIndex = intersection.faceIndex; // Index of the intersected face
            const point = intersection.point; // World coordinates of the intersection point

            // --- UPDATED: Lookup using faceMapArray and instanceDetails ---
            // Check if the face index is valid within the bounds of our map array
            if (faceIndex !== undefined && faceIndex !== null && faceIndex >= 0 && faceIndex < faceMapArray.length) {

                // Get the instance ID associated with this face from the binary map
                const clickedInstanceId = faceMapArray[faceIndex];

                // Check if the instance ID is valid (e.g., >= 0, assuming -1 or other value for "no instance")
                // and if we have details loaded for this instance ID
                if (clickedInstanceId >= 0 && instanceDetails.hasOwnProperty(clickedInstanceId)) {

                    // Retrieve the pre-loaded details for this instance
                    const instanceData = instanceDetails[clickedInstanceId];
                    const instanceIdStr = String(clickedInstanceId); // Use string for consistency in JS objects/keys

                    console.log(`Clicked Face: ${faceIndex}, Instance ID: ${instanceIdStr}, Label: ${instanceData.label}, CatID: ${instanceData.category_id}, Region: ${instanceData.region_label} (${instanceData.region_code})`);

                    // Add a temporary visual marker at the click point
                    addTemporaryDebugMarker(point);

                    // --- Populate Pending State for Confirmation ---
                    // Store the information needed for the confirmation step and potential save
                    pendingInstanceId = instanceIdStr;
                    pendingLabel = instanceData.label;
                    pendingCategoryId = instanceData.category_id;
                    pendingRegionLabel = instanceData.region_label || "N/A"; // Use fallback if missing
                    pendingRegionCode = instanceData.region_code || "-";     // Use fallback if missing

                    // Update the text content of the confirmation UI elements
                    if (pendingInstanceIdSpan) pendingInstanceIdSpan.textContent = pendingInstanceId;
                    if (pendingCategoryIdSpan) pendingCategoryIdSpan.textContent = pendingCategoryId;
                    if (pendingLabelSpan) pendingLabelSpan.textContent = pendingLabel;
                    if (pendingRegionLabelSpan) pendingRegionLabelSpan.textContent = pendingRegionLabel;
                    if (pendingRegionCodeSpan) pendingRegionCodeSpan.textContent = pendingRegionCode;
                    // --- End Populate Pending State ---

                    // Check if this instance already has a saved annotation
                    if (savedAnnotationsData.hasOwnProperty(instanceIdStr)) {
                        const savedData = savedAnnotationsData[instanceIdStr];
                        // Display existing annotation info in the confirmation prompt
                        if (existingAnnotationInfoP) {
                            existingAnnotationInfoP.innerHTML = `已标注: <strong>${savedData.finalLabel}</strong><br>查询: "${savedData.query || '无'}"`; // Show query or '无'
                            existingAnnotationInfoP.style.display = 'block';
                        }
                        console.log(`Instance ${instanceIdStr} already has saved annotation.`);
                    } else {
                        // Hide the existing annotation info paragraph if none exists
                        if (existingAnnotationInfoP) existingAnnotationInfoP.style.display = 'none';
                    }

                    // Show the confirmation section, hide the main annotation section
                    if (confirmationSection) confirmationSection.style.display = 'block';
                    if (annotationSection) annotationSection.style.display = 'none';
                    clearHighlight(); // Clear any previous yellow highlight

                } else {
                    // The clicked face belongs to an instance ID that is invalid (-1) or not found in the details map.
                    // This could be background geometry or an error in data processing.
                     console.warn(`Clicked face index ${faceIndex} maps to invalid/unknown instance ID ${clickedInstanceId}. Not selectable.`);
                     showError(`点击的区域 (面 ${faceIndex}) 没有有效的物体信息 (ID: ${clickedInstanceId})。`);
                     hideConfirmationPrompt(); // Don't show confirmation for non-objects
                     clearHighlight(); // Clear any previous highlight
                }
            } else {
                // This case should ideally not happen if faceMapArray is loaded correctly and faceIndex is valid.
                // It might indicate an issue with the raycasting result or the faceMapArray itself.
                console.warn(`Clicked face index ${faceIndex} is out of bounds or invalid for faceMapArray (length: ${faceMapArray.length}).`);
                showError(`点击的面 (${faceIndex}) 索引无效或映射数据错误。`);
                hideConfirmationPrompt();
                clearHighlight();
            }
            // --- END UPDATED LOOKUP ---
        } else {
            // Raycaster did not intersect with the model
            console.log("Click missed the mesh.");
            // If the confirmation prompt was visible, hide it on a missed click.
            if (confirmationSection?.style.display === 'block') {
                hideConfirmationPrompt();
                clearTemporaryMarker(); // Clear the marker from the previous valid click
                // Optionally clear highlight too if needed
                // clearHighlight();
            }
        }
    } catch (e) {
        console.error("Error during pointer down event handling:", e);
        showError("处理点击时发生内部错误。");
        // Reset UI state on error
        hideConfirmationPrompt();
        clearTemporaryMarker();
        clearHighlight();
    }
}


function handleCancelSelection() {
    console.log("Selection confirmation cancelled by user.");
    hideConfirmationPrompt(); // Hide the confirmation box
    clearTemporaryMarker(); // Remove the red click marker
    // Optionally clear highlight if it was shown before confirmation (though it shouldn't be)
    // clearHighlight();
}


function handleConfirmSelection() {
     // Check if there's a valid pending selection to confirm
     if (pendingInstanceId === null || pendingInstanceId === undefined) {
         console.warn("Confirm button clicked, but no pending instance ID found.");
         return; // Do nothing if no selection is pending
     }

     const instanceIdStr = String(pendingInstanceId);
     console.log(`User confirmed selection: Instance ${instanceIdStr}, Label: ${pendingLabel}, CatID: ${pendingCategoryId}, Region: ${pendingRegionLabel} (${pendingRegionCode})`);

     // Store the confirmed data in the `selectedInstance` global variable
     // This data comes from the `pending...` variables populated during `onPointerDown`
     selectedInstance = {
         id: instanceIdStr,
         label: pendingLabel,
         categoryId: pendingCategoryId,
         regionLabel: pendingRegionLabel,
         regionCode: pendingRegionCode,
         boundingBox: null // Bounding box will be calculated during the highlight step
     };

     // Update UI after confirmation
     hideConfirmationPrompt(); // Hide the confirmation box
     if (existingAnnotationInfoP) existingAnnotationInfoP.style.display = 'none'; // Ensure existing info is hidden now

     // Display selected instance info in the main annotation area
     if (infoDiv) {
         infoDiv.innerHTML = `已选: 实例 <strong>${selectedInstance.id}</strong> (初始标签: <strong>${selectedInstance.label}</strong>, CatID: ${selectedInstance.categoryId}, 区域: <strong>${selectedInstance.regionLabel}</strong> (${selectedInstance.regionCode || '-'}))`;
     }

     // Pre-fill annotation fields based on existing saved data (if any) or the original data
     let existingQuery = '';
     let existingLabel = selectedInstance.label; // Default to the original label from the model data

     if (savedAnnotationsData.hasOwnProperty(instanceIdStr)) {
         const savedData = savedAnnotationsData[instanceIdStr];
         existingLabel = savedData.finalLabel; // Use the previously saved final label
         existingQuery = savedData.query || ''; // Use the saved query
         console.log(`Pre-filling annotation fields for existing instance ${instanceIdStr} with saved data.`);
     } else {
         console.log(`Pre-filling annotation fields for new instance ${instanceIdStr} with initial data.`);
     }

     // Set the values in the input fields
     if (labelModifyInput) {
        labelModifyInput.value = existingLabel; // Set label input
     }
     if (queryInput) {
         queryInput.value = existingQuery; // Set query textarea
         // Update placeholder to guide user
         queryInput.placeholder = `描述 '${labelModifyInput.value || '该物体'}' (位于 ${selectedInstance.regionLabel})...`;
         queryInput.focus(); // Optionally focus the query input
     }

     // Enable the save button and show the annotation section
     if (saveButton) saveButton.disabled = false;
     if (annotationSection) annotationSection.style.display = 'block';

     // --- Trigger Highlight and BBox Calculation ---
     // Now that selection is confirmed, highlight the object and calculate its bounding box
     highlightInstance(selectedInstance.id, selectedInstance.label);
 }


// *** MODIFIED highlightInstance Function ***
function highlightInstance(targetInstanceId, targetLabel) {
    // --- UPDATED: Check prerequisites including faceMapArray ---
    if (!currentMesh || !faceMapArray || !scene) {
        console.warn("Highlight prerequisites not met (mesh, faceMapArray, scene). Cannot highlight.");
        return;
    }
    clearHighlight(); // Clear previous highlight AND temp bbox helper first
    console.log(`Attempting to highlight Instance ID: ${targetInstanceId} (Label: ${targetLabel})...`);

    // --- Find the correct mesh node, geometry, and world matrix ---
    // This assumes the relevant geometry is within the `currentMesh` object tree.
    let meshGeometry = null;
    let worldMatrix = null;
    let targetMeshNode = null; // Keep track of the THREE.Mesh node containing the geometry

    // Traverse the loaded model to find the first visible mesh with the required attributes
    currentMesh.traverse(node => {
        // Check if it's a mesh, is visible, and has indexed geometry with positions
        if (node.isMesh && node.visible && node.geometry?.index && node.geometry?.attributes?.position) {
            // Use the first valid mesh found. Adapt if multiple meshes need separate handling.
            if (!targetMeshNode) {
                targetMeshNode = node;
                meshGeometry = node.geometry;
                node.updateMatrixWorld(true); // Ensure world matrix is current
                worldMatrix = node.matrixWorld; // Get the world transformation matrix
                 console.log(`Highlight: Found target geometry in mesh node: ${node.name || 'Unnamed'} (UUID: ${node.uuid})`);
            }
        }
    });

    // Check if we found a suitable mesh
    if (!targetMeshNode || !meshGeometry || !meshGeometry.index || !meshGeometry.attributes.position || !worldMatrix) {
        console.error("Highlight: Could not find a valid mesh node with indexed geometry and world matrix within the loaded model.");
        showError("高亮错误: 无法访问所需的几何数据。");
        selectedInstance.boundingBox = null; // Ensure bbox is null if highlight fails
        return;
    }
    // --- End Geometry Finding ---

    // --- Prepare data for the highlight mesh ---
    const highlightGeometry = new THREE.BufferGeometry(); // New geometry for the highlight
    const vertices = []; // Array to store vertex positions (x, y, z)
    const targetColor = new THREE.Color(0xffff00); // Yellow color for highlight
    const colors = []; // Array to store vertex colors (r, g, b)

    // Get attribute buffers from the source geometry
    const positionAttribute = meshGeometry.attributes.position; // Source vertex positions
    const indexAttribute = meshGeometry.index; // Source face indices (vertex indices)
    let facesFound = 0; // Counter for faces belonging to the target instance
    const tempVec = new THREE.Vector3(); // Reusable vector for calculations
    const targetIdNum = parseInt(targetInstanceId, 10); // Ensure target ID is a number for comparison

    // --- UPDATED: Iterate through faceMapArray to find relevant faces ---
    console.log(`Highlight: Checking ${faceMapArray.length} faces in faceMapArray against target ID ${targetIdNum}...`);
    const numFaceIndicesTotal = indexAttribute.count; // Total number of indices in the geometry's index buffer

    for (let faceIndex = 0; faceIndex < faceMapArray.length; faceIndex++) {
        // Check if the instance ID stored for this face matches the target ID
        if (faceMapArray[faceIndex] === targetIdNum) {
            // Calculate the starting index in the geometry's index buffer for this face
            // Each face has 3 vertices, so 3 indices per face.
            const baseVertexIndex = faceIndex * 3;

            // --- Bounds Check ---
            // Verify that accessing these indices won't go out of bounds of the index buffer
            if (baseVertexIndex + 2 < numFaceIndicesTotal) {
                facesFound++;

                // Get the indices of the three vertices forming this face
                const a = indexAttribute.getX(baseVertexIndex);
                const b = indexAttribute.getX(baseVertexIndex + 1);
                const c = indexAttribute.getX(baseVertexIndex + 2);

                // Get the local vertex positions from the source geometry's position attribute
                // Clone them and transform them to world coordinates using the mesh's world matrix
                const vA = tempVec.fromBufferAttribute(positionAttribute, a).clone().applyMatrix4(worldMatrix);
                const vB = tempVec.fromBufferAttribute(positionAttribute, b).clone().applyMatrix4(worldMatrix);
                const vC = tempVec.fromBufferAttribute(positionAttribute, c).clone().applyMatrix4(worldMatrix);

                // Add the world-space vertex coordinates to the highlight geometry's vertex list
                vertices.push(vA.x, vA.y, vA.z, vB.x, vB.y, vB.z, vC.x, vC.y, vC.z);

                // Add the highlight color for each vertex of the face
                colors.push(targetColor.r, targetColor.g, targetColor.b, targetColor.r, targetColor.g, targetColor.b, targetColor.r, targetColor.g, targetColor.b);

            } else {
                // Log a warning if a face index from faceMap seems invalid for the geometry
                console.warn(`Highlight: Face index ${faceIndex} (from faceMapArray, maps to instance ${targetIdNum}) seems out of bounds for geometry index buffer (${numFaceIndicesTotal} indices). Skipping face.`);
                // This might indicate data corruption or a mismatch between faceMap and geometry.
            }
             // --- End Bounds Check ---
        }
    }
    // --- END UPDATED LOOP ---

    // Check if any faces were actually found for this instance
    if (facesFound === 0) {
        console.warn(`Highlight: No faces found for Instance ID ${targetInstanceId}. The instance might be empty, hidden, or there's a data mismatch.`);
        if (selectedInstance) selectedInstance.boundingBox = null; // Ensure bbox is null if no highlight geometry
        // Do not add an empty mesh to the scene
        return;
    }

    console.log(`Highlight: Found ${facesFound} faces for Instance ID ${targetInstanceId}. Creating highlight mesh geometry...`);

    // --- Create the Highlight Mesh ---
    // Set the attributes for the highlight geometry
    highlightGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    highlightGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    // Optional: Compute normals if lighting affects the highlight material (though MeshBasicMaterial ignores lighting)
    // highlightGeometry.computeVertexNormals();

    // Create the material for the highlight mesh
    const highlightMaterial = new THREE.MeshBasicMaterial({
        vertexColors: true,        // Use the colors defined in the geometry attribute
        side: THREE.DoubleSide,    // Render both front and back faces of the highlight
        transparent: true,         // Allow seeing through the highlight
        opacity: 0.6,              // Set transparency level (adjust as needed)
        depthTest: false           // Render highlight on top of the original mesh (ignores depth buffer)
        // Optional: polygonOffset: true, polygonOffsetFactor: -0.1 // Helps prevent z-fighting if depthTest is true
    });

    // Create the highlight mesh object
    currentHighlightMesh = new THREE.Mesh(highlightGeometry, highlightMaterial);
    currentHighlightMesh.renderOrder = 1; // Ensure highlight renders after main mesh (renderOrder 0) but before markers (renderOrder 2)
    // --- End Create Highlight Mesh ---

    // --- Calculate Bounding Box of the Highlight and Create TEMPORARY Helper ---
    let calculatedBoundingBox = null; // Variable to store the serializable bbox data
    try {
        // Compute the bounding box of the newly created highlight geometry
        highlightGeometry.computeBoundingBox();

        // Check if the bounding box is valid and not empty
        if (highlightGeometry.boundingBox && !highlightGeometry.boundingBox.isEmpty()) {
            const box = highlightGeometry.boundingBox.clone(); // Clone the box for the helper

            clearTemporaryBBoxHelper(); // Remove any previous temporary bbox helper

            // Create a new temporary (red) Box3Helper for visual feedback
            currentTemporaryBBoxHelper = new THREE.Box3Helper(box, TEMP_BBOX_COLOR);
            currentTemporaryBBoxHelper.renderOrder = 2; // Render on top
            scene.add(currentTemporaryBBoxHelper);
            console.log("Temporary bbox helper added for highlight visualization.");

            // Prepare the bounding box data in a serializable format (simple min/max object)
            // This is the data that will be stored in `selectedInstance.boundingBox` and saved
            calculatedBoundingBox = {
                min: { x: box.min.x, y: box.min.y, z: box.min.z },
                max: { x: box.max.x, y: box.max.y, z: box.max.z }
            };
        } else {
            console.warn("Highlight: Could not compute bounding box for the highlighted geometry, or the computed box was empty.");
        }
    } catch (bboxError) {
        console.error("Highlight: Error during bounding box computation or helper creation:", bboxError);
    }
    // --- End Bounding Box Calculation ---

    // Store the calculated bounding box data on the currently selected instance object
    // This makes it available when the 'Save' button is clicked
    if (selectedInstance) {
        selectedInstance.boundingBox = calculatedBoundingBox;
        console.log("Stored calculated bbox on selectedInstance:", calculatedBoundingBox);
    } else {
        console.warn("Highlight: selectedInstance is null. Cannot store calculated bounding box.");
    }

    // Add the created highlight mesh to the scene
    scene.add(currentHighlightMesh);
    console.log("Highlight mesh added to the scene.");
}
// *** End MODIFIED highlightInstance Function ***


function clearScene() {
    console.log("Clearing current scene...");

    // Reset application state related to the current scene and selection
    resetAnnotationState(); // Handles selection, visuals, UI state, and NEW data maps

    // Remove the main mesh object from the scene graph
    if (currentMesh?.parent === scene) {
        scene.remove(currentMesh);
        console.log("Removed previous mesh from scene graph.");

        // --- Dispose of Geometry and Materials ---
        // Traverse the removed mesh to properly dispose of its resources
        currentMesh.traverse(node => {
            if (node.isMesh) {
                // Dispose geometry
                if (node.geometry) {
                    node.geometry.dispose();
                     // console.log(`Disposed geometry for mesh: ${node.name || node.uuid}`);
                }
                // Dispose material(s)
                if (node.material) {
                    // Handle both single material and array of materials
                    const materials = Array.isArray(node.material) ? node.material : [node.material];
                    materials.forEach((material, index) => {
                        if (material) {
                            // Dispose textures associated with the material
                            for (const key in material) {
                                if (Object.prototype.hasOwnProperty.call(material, key)) {
                                    const value = material[key];
                                    if (value && typeof value === 'object' && value.isTexture) {
                                        value.dispose();
                                        // console.log(`Disposed texture '${key}' for material ${index} on mesh: ${node.name || node.uuid}`);
                                    }
                                }
                            }
                            // Dispose the material itself
                            material.dispose();
                             // console.log(`Disposed material ${index} for mesh: ${node.name || node.uuid}`);
                        }
                    });
                }
            }
        });
         console.log("Disposed resources for previous mesh.");
        // --- End Dispose ---
    } else if (currentMesh) {
        console.warn("currentMesh exists but was not attached to the scene.");
        // Attempt disposal anyway if mesh exists but wasn't added
        // (Copy traversal logic from above if needed, though unlikely)
    }


    // Nullify references to scene-specific objects
    currentMesh = null;
    currentSceneId = null;
    currentSceneRoot = null; // Reset reference to the loaded GLTF scene root
    modelCenter.set(0, 0, 0); // Reset model center

    // Note: instanceDetails and faceMapArray are reset inside resetAnnotationState()

    console.log("Scene clearing complete.");

    // Optionally, reset camera position/target?
    // camera.position.set(0, -3, 3);
    // controls.target.set(0, 0, 0);
    // controls.update();
}


function saveAnnotation() {
    // --- 1. Validation ---
    if (!selectedInstance || !selectedInstance.id) {
        showSaveStatus("错误: 没有选择有效的实例进行保存。", true);
        console.warn("Save aborted: selectedInstance is null or has no ID.");
        return;
    }
    if (!currentSceneId) {
        showSaveStatus("错误: 未加载场景ID，无法保存。", true);
        console.warn("Save aborted: currentSceneId is null.");
        return;
    }

    const finalLabel = labelModifyInput?.value.trim() ?? ''; // Get final label from input
    const query = queryInput?.value.trim() ?? ''; // Get query from textarea

    // Require both label and query
    if (!finalLabel) {
        showSaveStatus("错误: 必须提供最终标签。", true);
        labelModifyInput?.focus(); // Focus the problematic input
        return;
    }
     if (!query) {
        showSaveStatus("错误: 必须提供描述性查询。", true);
        queryInput?.focus(); // Focus the problematic input
        return;
    }

    // --- 2. Prepare Data ---
    const instanceIdStr = String(selectedInstance.id);

    // Construct the data payload to send to the backend
    // Most data comes directly from the `selectedInstance` object,
    // which was populated during `handleConfirmSelection` and potentially
    // updated with bounding box info during `highlightInstance`.
    const annotationData = {
        scene_id: currentSceneId,
        instance_id: instanceIdStr, // The ID of the object being annotated
        original_category_id: selectedInstance.categoryId, // Original category ID from model data
        final_label_string: finalLabel, // The (potentially modified) label from the input field
        query: query, // The descriptive query from the textarea
        bounding_box: selectedInstance.boundingBox, // The calculated bounding box (can be null)
        region_label: selectedInstance.regionLabel || "N/A", // Region info associated with the instance
        region_code: selectedInstance.regionCode || "-"     // Region code associated with the instance
    };

    console.log("Preparing to save annotation:", JSON.stringify(annotationData, null, 2));
    showSaveStatus("正在保存...", false); // Indicate saving process
    if (saveButton) saveButton.disabled = true; // Disable save button during request

    // --- 3. Send Data to Backend ---
    fetch('/save_annotation', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(annotationData) // Convert JS object to JSON string
    })
    .then(response => {
        // Handle HTTP errors (e.g., 4xx, 5xx)
        if (!response.ok) {
            // Try to parse error details from backend response
            return response.json().catch(() => ({})).then(errData => {
                // Throw an error that includes backend message or HTTP status
                throw new Error(errData.description || `保存失败: 服务器错误 ${response.status}`);
            });
        }
        // Parse successful JSON response from backend
        return response.json();
    })
    .then(data => {
        // Handle successful save response from backend
        if (data.status === 'success') {
            showSaveStatus(`保存成功! 标签: '${data.saved_label}' (ID: ${data.saved_label_id})`, false);
            console.log("Annotation successfully saved:", data);

            let newMarker = null;
            let newBbox = null;

            // --- Convert Temporary Visuals to Persistent ---
            // Take ownership of the temporary visuals (click marker, highlight bbox)
            // and make them persistent (green).

            // Marker: Comes from the initial click (addTemporaryDebugMarker)
            if (currentTemporaryMarker) {
                newMarker = currentTemporaryMarker; // Transfer ownership
                newMarker.material.color.setHex(PERSISTENT_MARKER_COLOR); // Change color to green
                currentTemporaryMarker = null; // Clear the temporary reference
                console.log(`Converted temporary marker to persistent for instance ${instanceIdStr}`);
            } else {
                 console.warn(`Save success: No temporary marker found to make persistent for instance ${instanceIdStr}.`);
            }

            // BBox Helper: Comes from the highlight phase (highlightInstance)
            if (currentTemporaryBBoxHelper) {
                newBbox = currentTemporaryBBoxHelper; // Transfer ownership
                newBbox.material.color.setHex(PERSISTENT_BBOX_COLOR); // Change color to green
                currentTemporaryBBoxHelper = null; // Clear the temporary reference
                 console.log(`Converted temporary bbox helper to persistent for instance ${instanceIdStr}`);
            } else {
                 console.warn(`Save success: No temporary bbox helper found to make persistent for instance ${instanceIdStr}. BBox might be null or highlight failed.`);
            }
            // --- End Visual Conversion ---

            // --- Update Persistent Visuals Store ---
            // Remove any *old* persistent visuals associated with this instance ID first
            if (persistentVisuals.hasOwnProperty(instanceIdStr)) {
                const oldVisuals = persistentVisuals[instanceIdStr];
                if (oldVisuals.marker?.parent === scene) scene.remove(oldVisuals.marker);
                if (oldVisuals.bbox?.parent === scene) scene.remove(oldVisuals.bbox);
                // Dispose old geometries/materials to prevent memory leaks
                oldVisuals.marker?.geometry?.dispose();
                oldVisuals.marker?.material?.dispose();
                oldVisuals.bbox?.geometry?.dispose();
                oldVisuals.bbox?.material?.dispose();
                console.log(`Removed old persistent visuals for instance ${instanceIdStr} before adding new ones.`);
            }

            // Optional: Enforce limit on total persistent visuals
            if (Object.keys(persistentVisuals).length >= MAX_PERSISTENT_MARKERS && !persistentVisuals.hasOwnProperty(instanceIdStr)) {
                // Find and remove the oldest entry (e.g., based on insertion order - requires Map or careful object key handling)
                const firstKey = Object.keys(persistentVisuals)[0]; // Simple FIFO removal
                const oldestVisuals = persistentVisuals[firstKey];
                if (oldestVisuals) {
                    if (oldestVisuals.marker?.parent === scene) scene.remove(oldestVisuals.marker);
                    if (oldestVisuals.bbox?.parent === scene) scene.remove(oldestVisuals.bbox);
                    oldestVisuals.marker?.geometry?.dispose(); oldestVisuals.marker?.material?.dispose();
                    oldestVisuals.bbox?.geometry?.dispose(); oldestVisuals.bbox?.material?.dispose();
                }
                delete persistentVisuals[firstKey]; // Remove from tracker
                console.warn(`Max persistent visuals (${MAX_PERSISTENT_MARKERS}) reached. Removed oldest visual(s) for instance ${firstKey}.`);
            }

            // Store the newly converted persistent visuals (marker/bbox can be null if conversion failed)
            persistentVisuals[instanceIdStr] = { marker: newMarker, bbox: newBbox };
            console.log(`Stored persistent visuals for instance ${instanceIdStr}. Marker: ${!!newMarker}, BBox: ${!!newBbox}`);
            // --- End Persistent Visuals Store Update ---

            // --- Update In-Memory Cache ---
            // Update the local `savedAnnotationsData` cache to reflect the save immediately
            // Use the label confirmed by the server (`data.saved_label`)
            savedAnnotationsData[instanceIdStr] = {
                 finalLabel: data.saved_label,
                 query: query,
                 boundingBox: selectedInstance.boundingBox // Store the bbox that was saved
            };
             console.log(`Updated local savedAnnotationsData cache for instance ${instanceIdStr}.`);
            // --- End In-Memory Cache Update ---

            // --- Final UI State ---
            if (saveButton) saveButton.disabled = false; // Re-enable save button for next annotation
            clearHighlight(); // Clear the yellow highlight mesh (also clears temp bbox helper if it wasn't converted)

            // Decide whether to keep the annotation section open or clear/hide it.
            // Current behavior: Keep it open, allowing potential further edits or saving again.
            // To clear after save:
            // if (labelModifyInput) labelModifyInput.value = '';
            // if (queryInput) queryInput.value = '';
            // if (infoDiv) infoDiv.textContent = 'Selected: None';
            // if (annotationSection) annotationSection.style.display = 'none';
            // selectedInstance = null;
            // if (saveButton) saveButton.disabled = true;

        } else {
            // Backend indicated success=false or other unexpected status
            throw new Error(data.message || "Annotation save failed (server returned non-success status).");
        }
    })
    .catch(error => {
        // Handle errors during fetch or processing the response
        console.error("Error saving annotation:", error);
        showSaveStatus(`保存失败: ${error.message || '未知错误'}`, true);
        // Re-enable save button on error only if an instance is still selected
        if (saveButton && selectedInstance) saveButton.disabled = false;
    });
}


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
         } catch(e) {
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
// Add the main initialization function to the DOMContentLoaded event listener
document.addEventListener('DOMContentLoaded', init);

// --- END OF FILE main.js ---