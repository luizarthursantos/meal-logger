// Meal Logger PWA - Main Application with Google Sheets Integration

// Database configuration
const DB_NAME = 'MealLoggerDB';
const DB_VERSION = 2;
const STORE_NAME = 'meals';

// Google API configuration
const GOOGLE_CLIENT_ID = '381176979324-8t9p7um4b7srt2i00gjatm3d0gu372hs.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file';

let db = null;
let currentDate = new Date();
let deferredPrompt = null;

// Google Auth state
let tokenClient = null;
let accessToken = null;
let googleUser = null;
let selectedSheetId = null;

// Sync state
let isSyncing = false;
let pendingConflicts = [];

// Photo analysis state
let selectedPhotoBase64 = null;

// Generate a unique sync ID for meals
function generateSyncId() {
    return 'meal_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Initialize the app
document.addEventListener('DOMContentLoaded', async () => {
    await initDB();
    updateDateDisplay();
    await loadMeals();
    setupEventListeners();
    registerServiceWorker();
    loadSavedSettings();
    initGoogleAPI();
});

// Load saved settings from localStorage
function loadSavedSettings() {
    const savedSheetId = localStorage.getItem('mealLogger_sheetId');
    const savedSheetName = localStorage.getItem('mealLogger_sheetName');
    const savedUser = localStorage.getItem('mealLogger_user');
    const savedToken = localStorage.getItem('mealLogger_token');

    if (savedSheetId) {
        selectedSheetId = savedSheetId;
    }

    if (savedUser) {
        try {
            googleUser = JSON.parse(savedUser);
        } catch (e) {
            console.log('Could not parse saved user');
        }
    }

    if (savedToken) {
        accessToken = savedToken;
    }

    // Show sync status if we have a saved sheet
    if (selectedSheetId && savedSheetName) {
        updateSyncStatus('synced', savedSheetName);
    }
}

// Calculate calories from macros - GLOBAL FUNCTION
function calculateCalories() {
    const proteinInput = document.getElementById('protein');
    const carbsInput = document.getElementById('carbs');
    const fatInput = document.getElementById('fat');
    const caloriesInput = document.getElementById('calories');

    if (!proteinInput || !carbsInput || !fatInput || !caloriesInput) {
        console.log('Form inputs not found');
        return;
    }

    const protein = parseInt(proteinInput.value) || 0;
    const carbs = parseInt(carbsInput.value) || 0;
    const fat = parseInt(fatInput.value) || 0;

    // Protein: 4 cal/g, Carbs: 4 cal/g, Fat: 9 cal/g
    const calories = (protein * 4) + (carbs * 4) + (fat * 9);
    caloriesInput.value = calories;

    console.log(`Calculated calories: P:${protein} C:${carbs} F:${fat} = ${calories} cal`);
}

// Tab switching - GLOBAL FUNCTION
function switchTab(tabName) {
    console.log('Switching to tab:', tabName);

    // Update tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.id === tabName + 'Tab');
    });

    // Load analytics data when switching to analytics tab
    if (tabName === 'analytics') {
        loadMeals().then(() => {
            updateWeeklyAnalytics();
        });
    }
}

// Analytics sub-tab switching - GLOBAL FUNCTION
function switchAnalyticsSubTab(subtabName) {
    console.log('Switching analytics subtab to:', subtabName);

    document.querySelectorAll('.analytics-sub-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.subtab === subtabName);
    });

    document.getElementById('dailyAnalytics').style.display = subtabName === 'daily' ? 'block' : 'none';
    document.getElementById('weeklyAnalytics').style.display = subtabName === 'weekly' ? 'block' : 'none';

    if (subtabName === 'weekly') {
        updateWeeklyAnalytics();
    }
}

// Initialize Google API
function initGoogleAPI() {
    const checkGoogleAPI = setInterval(() => {
        if (typeof google !== 'undefined' && google.accounts) {
            clearInterval(checkGoogleAPI);
            setupGoogleAuth();
        }
    }, 100);

    const checkGapi = setInterval(() => {
        if (typeof gapi !== 'undefined') {
            clearInterval(checkGapi);
            gapi.load('client', initGapiClient);
        }
    }, 100);
}

async function initGapiClient() {
    try {
        await gapi.client.init({});
        await gapi.client.load('sheets', 'v4');
        await gapi.client.load('drive', 'v3');
        console.log('Google API client initialized');

        // If we have a saved token, try to use it
        if (accessToken) {
            gapi.client.setToken({ access_token: accessToken });
            // Verify the token is still valid by making a simple request
            tryRestoreSession();
        }
    } catch (error) {
        console.error('Error initializing Google API client:', error);
    }
}

// Try to restore the previous session
async function tryRestoreSession() {
    try {
        // Test if the token is still valid
        const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (response.ok) {
            googleUser = await response.json();
            localStorage.setItem('mealLogger_user', JSON.stringify(googleUser));
            updateGoogleAccountUI();
            console.log('Session restored successfully');

            // Show sync status
            const savedSheetName = localStorage.getItem('mealLogger_sheetName');
            if (selectedSheetId && savedSheetName) {
                updateSyncStatus('synced', savedSheetName);

                // Auto-sync on app open - pull changes from Google Sheets
                console.log('Auto-syncing on app open...');
                setTimeout(() => {
                    smartSync();
                }, 1000); // Small delay to ensure everything is loaded
            }
        } else {
            // Token expired, clear it
            console.log('Token expired, clearing session');
            clearSavedSession();
        }
    } catch (error) {
        console.log('Could not restore session:', error);
        clearSavedSession();
    }
}

function clearSavedSession() {
    accessToken = null;
    localStorage.removeItem('mealLogger_token');
    updateGoogleAccountUI();
}

function setupGoogleAuth() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: SCOPES,
        callback: handleAuthCallback,
    });

    updateGoogleAccountUI();
}

function handleAuthCallback(response) {
    if (response.error) {
        console.error('Auth error:', response);
        showToast('Failed to sign in', 'error');
        return;
    }

    accessToken = response.access_token;
    // Save token to localStorage for persistence
    localStorage.setItem('mealLogger_token', accessToken);
    gapi.client.setToken({ access_token: accessToken });
    fetchUserInfo();
}

async function fetchUserInfo() {
    try {
        const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        googleUser = await response.json();
        localStorage.setItem('mealLogger_user', JSON.stringify(googleUser));
        updateGoogleAccountUI();
        showToast('Signed in successfully', 'success');

        document.getElementById('sheetsSection').style.display = 'block';
        loadUserSheets();

        // Auto-sync if we have a selected sheet
        if (selectedSheetId) {
            const savedSheetName = localStorage.getItem('mealLogger_sheetName');
            updateSyncStatus('synced', savedSheetName || 'Google Sheets');
        }
    } catch (error) {
        console.error('Error fetching user info:', error);
    }
}

function signIn() {
    if (tokenClient) {
        tokenClient.requestAccessToken({ prompt: 'consent' });
    } else {
        showToast('Google API not loaded yet', 'error');
    }
}

function signOut() {
    if (accessToken) {
        google.accounts.oauth2.revoke(accessToken, () => {
            accessToken = null;
            googleUser = null;
            selectedSheetId = null;
            localStorage.removeItem('mealLogger_user');
            localStorage.removeItem('mealLogger_sheetId');
            localStorage.removeItem('mealLogger_sheetName');
            localStorage.removeItem('mealLogger_token');
            updateGoogleAccountUI();
            document.getElementById('sheetsSection').style.display = 'none';
            updateSyncStatus('hidden');
            showToast('Signed out', 'success');
        });
    }
}

function updateGoogleAccountUI() {
    const container = document.getElementById('googleAccountSection');

    if (googleUser && accessToken) {
        container.innerHTML = `
            <div class="google-account">
                <img src="${googleUser.picture || 'icons/icon-72.png'}" alt="Profile" onerror="this.src='icons/icon-72.png'">
                <div class="google-account-info">
                    <div class="name">${escapeHtml(googleUser.name || 'Google User')}</div>
                    <div class="email">${escapeHtml(googleUser.email || '')}</div>
                </div>
            </div>
            <button class="google-btn sign-out" onclick="signOut()">
                Sign Out
            </button>
        `;
        document.getElementById('sheetsSection').style.display = 'block';
        if (typeof gapi !== 'undefined' && gapi.client) {
            loadUserSheets();
        }
    } else {
        container.innerHTML = `
            <button class="google-btn" onclick="signIn()">
                <svg viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Sign in with Google
            </button>
        `;
        document.getElementById('sheetsSection').style.display = 'none';
    }
}

async function loadUserSheets() {
    const container = document.getElementById('sheetsList');
    container.innerHTML = '<div class="loading-spinner">Loading spreadsheets...</div>';

    try {
        const response = await gapi.client.drive.files.list({
            q: "mimeType='application/vnd.google-apps.spreadsheet'",
            fields: 'files(id, name, modifiedTime)',
            orderBy: 'modifiedTime desc',
            pageSize: 20
        });

        const sheets = response.result.files || [];

        if (sheets.length === 0) {
            container.innerHTML = '<div class="no-sheets">No spreadsheets found. Create a new one to get started.</div>';
        } else {
            container.innerHTML = '<div class="sheets-list">' + sheets.map(sheet => `
                <div class="sheet-option ${sheet.id === selectedSheetId ? 'selected' : ''}"
                     onclick="selectSheet('${sheet.id}', '${escapeHtml(sheet.name)}')">
                    <svg viewBox="0 0 24 24" fill="#0f9d58">
                        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM7 10h2v7H7zm4-3h2v10h-2zm4 6h2v4h-2z"/>
                    </svg>
                    <div class="sheet-option-info">
                        <div class="name">${escapeHtml(sheet.name)}</div>
                        <div class="detail">Modified ${formatRelativeTime(sheet.modifiedTime)}</div>
                    </div>
                </div>
            `).join('') + '</div>';
        }

        updateSheetButtons();
    } catch (error) {
        console.error('Error loading sheets:', error);
        container.innerHTML = '<div class="no-sheets">Error loading spreadsheets. Please try again.</div>';
    }
}

function formatRelativeTime(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    return date.toLocaleDateString();
}

function selectSheet(sheetId, sheetName) {
    selectedSheetId = sheetId;
    localStorage.setItem('mealLogger_sheetId', sheetId);
    localStorage.setItem('mealLogger_sheetName', sheetName);

    loadUserSheets();
    updateSheetButtons();
    updateSyncStatus('synced', sheetName);

    // Auto-sync when a sheet is selected
    setTimeout(() => {
        smartSync();
    }, 500);
}

function updateSheetButtons() {
    const loadBtn = document.getElementById('loadFromSheet');
    const syncBtn = document.getElementById('syncNowBtn');

    if (selectedSheetId) {
        loadBtn.disabled = false;
        syncBtn.disabled = false;
    } else {
        loadBtn.disabled = true;
        syncBtn.disabled = true;
    }
}

async function createNewSheet() {
    try {
        updateSyncStatus('syncing', 'Creating new spreadsheet...');

        const response = await gapi.client.sheets.spreadsheets.create({
            properties: {
                title: `Meal Logger - ${new Date().toLocaleDateString()}`
            },
            sheets: [{
                properties: {
                    title: 'Meals'
                }
            }]
        });

        const sheetId = response.result.spreadsheetId;
        const sheetName = response.result.properties.title;

        // Add headers with sugar field
        await gapi.client.sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: 'Meals!A1:J1',
            valueInputOption: 'RAW',
            resource: {
                values: [['ID', 'Date', 'Name', 'Type', 'Calories', 'Protein', 'Carbs', 'Fat', 'Sugar', 'Notes']]
            }
        });

        selectedSheetId = sheetId;
        localStorage.setItem('mealLogger_sheetId', sheetId);
        localStorage.setItem('mealLogger_sheetName', sheetName);

        showToast('Spreadsheet created!', 'success');
        loadUserSheets();
        updateSyncStatus('synced', sheetName);

        await syncToSheet();
    } catch (error) {
        console.error('Error creating sheet:', error);
        showToast('Failed to create spreadsheet', 'error');
        updateSyncStatus('error');
    }
}

async function syncToSheet() {
    if (!selectedSheetId || !accessToken) return;

    try {
        updateSyncStatus('syncing');

        const allMeals = await getAllMeals();

        // Update headers to include new sync fields
        await gapi.client.sheets.spreadsheets.values.update({
            spreadsheetId: selectedSheetId,
            range: 'Meals!A1:L1',
            valueInputOption: 'RAW',
            resource: {
                values: [['ID', 'Date', 'Name', 'Type', 'Calories', 'Protein', 'Carbs', 'Fat', 'Sugar', 'Notes', 'SyncId', 'ModifiedAt']]
            }
        });

        await gapi.client.sheets.spreadsheets.values.clear({
            spreadsheetId: selectedSheetId,
            range: 'Meals!A2:L10000'
        });

        if (allMeals.length > 0) {
            const rows = allMeals.map(meal => [
                meal.id || '',
                meal.date || '',
                meal.name || '',
                meal.type || '',
                meal.calories || 0,
                meal.protein || 0,
                meal.carbs || 0,
                meal.fat || 0,
                meal.sugar || 0,
                meal.notes || '',
                meal.syncId || generateSyncId(),
                meal.modifiedAt || new Date().toISOString()
            ]);

            await gapi.client.sheets.spreadsheets.values.update({
                spreadsheetId: selectedSheetId,
                range: 'Meals!A2',
                valueInputOption: 'RAW',
                resource: { values: rows }
            });
        }

        // Save last sync time
        localStorage.setItem('mealLogger_lastSync', new Date().toISOString());

        const sheetName = localStorage.getItem('mealLogger_sheetName') || 'Google Sheets';
        updateSyncStatus('synced', sheetName);
        showToast('Synced to Google Sheets', 'success');
    } catch (error) {
        console.error('Error syncing to sheet:', error);
        updateSyncStatus('error');
        showToast('Sync failed', 'error');
    }
}

// Smart sync with conflict detection
async function smartSync() {
    if (!selectedSheetId || !accessToken || isSyncing) return;

    isSyncing = true;

    try {
        updateSyncStatus('syncing');

        // Get local meals
        const localMeals = await getAllMeals();

        // Get remote meals from Google Sheet
        let remoteMeals = [];
        try {
            const response = await gapi.client.sheets.spreadsheets.values.get({
                spreadsheetId: selectedSheetId,
                range: 'Meals!A2:L10000'
            });

            const rows = response.result.values || [];
            remoteMeals = rows.map(row => ({
                id: parseInt(row[0]) || null,
                date: row[1] || '',
                name: row[2] || '',
                type: row[3] || 'snack',
                calories: parseInt(row[4]) || 0,
                protein: parseInt(row[5]) || 0,
                carbs: parseInt(row[6]) || 0,
                fat: parseInt(row[7]) || 0,
                sugar: parseInt(row[8]) || 0,
                notes: row[9] || '',
                syncId: row[10] || null,
                modifiedAt: row[11] || null
            })).filter(meal => meal.name); // Filter out empty rows
        } catch (error) {
            console.log('No existing data in sheet or sheet is new');
        }

        // Build maps for comparison
        const localBySyncId = new Map();
        const localWithoutSyncId = [];

        localMeals.forEach(meal => {
            if (meal.syncId) {
                localBySyncId.set(meal.syncId, meal);
            } else {
                localWithoutSyncId.push(meal);
            }
        });

        const remoteBySyncId = new Map();
        remoteMeals.forEach(meal => {
            if (meal.syncId) {
                remoteBySyncId.set(meal.syncId, meal);
            }
        });

        // Detect conflicts and changes
        const conflicts = [];
        const newFromRemote = [];
        const localOnlyMeals = [];

        // Check for conflicts and new remote meals
        for (const [syncId, remoteMeal] of remoteBySyncId) {
            const localMeal = localBySyncId.get(syncId);

            if (localMeal) {
                // Both have this meal - check for conflicts
                const localModified = localMeal.modifiedAt ? new Date(localMeal.modifiedAt).getTime() : 0;
                const remoteModified = remoteMeal.modifiedAt ? new Date(remoteMeal.modifiedAt).getTime() : 0;

                // Check if content actually differs
                if (mealsAreDifferent(localMeal, remoteMeal)) {
                    if (localModified !== remoteModified) {
                        conflicts.push({ local: localMeal, remote: remoteMeal });
                    }
                }
            } else {
                // New meal from remote
                newFromRemote.push(remoteMeal);
            }
        }

        // Find meals that only exist locally
        for (const [syncId, localMeal] of localBySyncId) {
            if (!remoteBySyncId.has(syncId)) {
                localOnlyMeals.push(localMeal);
            }
        }

        // Also include meals without syncId as local-only
        localWithoutSyncId.forEach(meal => localOnlyMeals.push(meal));

        // If there are conflicts, show conflict resolution UI
        if (conflicts.length > 0) {
            pendingConflicts = conflicts;
            showConflictModal(conflicts, newFromRemote, localOnlyMeals);
            isSyncing = false;
            return;
        }

        // No conflicts - merge automatically
        await performMerge(newFromRemote, localOnlyMeals, []);

        // Also sync targets from Google Sheets
        await syncTargetsFromSheet();

    } catch (error) {
        console.error('Smart sync error:', error);
        updateSyncStatus('error');
        showToast('Sync failed', 'error');
    }

    isSyncing = false;
}

// Sync targets from Google Sheets to localStorage
async function syncTargetsFromSheet() {
    const remoteTargets = await loadTargetsFromSheet();
    if (remoteTargets) {
        const localTargets = getMacroTargets();

        // If remote has targets and local doesn't, use remote
        // If both have targets, prefer the one with values
        const hasRemote = remoteTargets.protein || remoteTargets.carbs || remoteTargets.fat || remoteTargets.sugar;
        const hasLocal = localTargets.protein || localTargets.carbs || localTargets.fat || localTargets.sugar;

        if (hasRemote && !hasLocal) {
            // Use remote targets
            localStorage.setItem('mealLogger_targetProtein', remoteTargets.protein.toString());
            localStorage.setItem('mealLogger_targetCarbs', remoteTargets.carbs.toString());
            localStorage.setItem('mealLogger_targetFat', remoteTargets.fat.toString());
            localStorage.setItem('mealLogger_targetSugar', remoteTargets.sugar.toString());
            console.log('Loaded targets from Google Sheets');
            // Refresh the display
            loadMeals();
        } else if (hasLocal && !hasRemote) {
            // Push local targets to remote
            await syncTargetsToSheet(localTargets);
        }
    }
}

// Check if two meals have different content
function mealsAreDifferent(meal1, meal2) {
    return meal1.name !== meal2.name ||
           meal1.type !== meal2.type ||
           meal1.date !== meal2.date ||
           meal1.calories !== meal2.calories ||
           meal1.protein !== meal2.protein ||
           meal1.carbs !== meal2.carbs ||
           meal1.fat !== meal2.fat ||
           meal1.sugar !== meal2.sugar ||
           meal1.notes !== meal2.notes;
}

// Perform the actual merge operation
async function performMerge(newFromRemote, localOnlyMeals, resolvedConflicts) {
    try {
        updateSyncStatus('syncing', 'Merging...');

        // Add new meals from remote to local DB
        for (const remoteMeal of newFromRemote) {
            const meal = {
                ...remoteMeal,
                id: undefined, // Let IndexedDB assign new ID
                timestamp: new Date().toISOString()
            };
            delete meal.id;
            await addMeal(meal);
        }

        // Ensure all local meals have syncId and modifiedAt
        const allLocalMeals = await getAllMeals();
        for (const meal of allLocalMeals) {
            if (!meal.syncId || !meal.modifiedAt) {
                meal.syncId = meal.syncId || generateSyncId();
                meal.modifiedAt = meal.modifiedAt || new Date().toISOString();
                await updateMeal(meal);
            }
        }

        // Apply conflict resolutions
        for (const resolution of resolvedConflicts) {
            if (resolution.choice === 'remote') {
                // Update local with remote data
                const localMeal = await getMealBySyncId(resolution.syncId);
                if (localMeal) {
                    const updatedMeal = {
                        ...resolution.remote,
                        id: localMeal.id,
                        timestamp: new Date().toISOString()
                    };
                    await updateMeal(updatedMeal);
                }
            }
            // If choice is 'local', we keep local data (no action needed)
        }

        // Now sync everything back to Google Sheets
        await syncToSheet();

        // Reload meals display
        await loadMeals();

        const sheetName = localStorage.getItem('mealLogger_sheetName') || 'Google Sheets';
        updateSyncStatus('synced', sheetName);

        if (newFromRemote.length > 0) {
            showToast(`Synced: ${newFromRemote.length} new meal(s) from cloud`, 'success');
        } else {
            showToast('Synced with Google Sheets', 'success');
        }

    } catch (error) {
        console.error('Merge error:', error);
        updateSyncStatus('error');
        showToast('Merge failed', 'error');
    } finally {
        isSyncing = false;
    }
}

// Get meal by syncId
function getMealBySyncId(syncId) {
    return new Promise((resolve, reject) => {
        if (!db) {
            resolve(null);
            return;
        }

        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.openCursor();

        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                if (cursor.value.syncId === syncId) {
                    resolve(cursor.value);
                    return;
                }
                cursor.continue();
            } else {
                resolve(null);
            }
        };

        request.onerror = () => reject(request.error);
    });
}

// Show conflict resolution modal
function showConflictModal(conflicts, newFromRemote, localOnlyMeals) {
    const overlay = document.getElementById('conflictOverlay');
    const container = document.getElementById('conflictList');

    let html = `
        <p style="color: var(--text-secondary); margin-bottom: 20px;">
            Found ${conflicts.length} meal(s) that were modified on both this device and another device.
            Choose which version to keep for each:
        </p>
    `;

    conflicts.forEach((conflict, index) => {
        const localDate = conflict.local.modifiedAt ? new Date(conflict.local.modifiedAt).toLocaleString() : 'Unknown';
        const remoteDate = conflict.remote.modifiedAt ? new Date(conflict.remote.modifiedAt).toLocaleString() : 'Unknown';

        html += `
            <div class="conflict-item" data-index="${index}" data-syncid="${conflict.local.syncId}">
                <div class="conflict-meal-name">${escapeHtml(conflict.local.name)}</div>
                <div class="conflict-options">
                    <label class="conflict-option">
                        <input type="radio" name="conflict_${index}" value="local" checked>
                        <div class="conflict-option-content">
                            <div class="conflict-option-header">
                                <span class="conflict-badge local">This Device</span>
                                <span class="conflict-time">${localDate}</span>
                            </div>
                            <div class="conflict-details">
                                ${conflict.local.calories} cal • ${conflict.local.protein}g P • ${conflict.local.carbs}g C • ${conflict.local.fat}g F
                            </div>
                        </div>
                    </label>
                    <label class="conflict-option">
                        <input type="radio" name="conflict_${index}" value="remote">
                        <div class="conflict-option-content">
                            <div class="conflict-option-header">
                                <span class="conflict-badge remote">Cloud</span>
                                <span class="conflict-time">${remoteDate}</span>
                            </div>
                            <div class="conflict-details">
                                ${conflict.remote.calories} cal • ${conflict.remote.protein}g P • ${conflict.remote.carbs}g C • ${conflict.remote.fat}g F
                            </div>
                        </div>
                    </label>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;

    // Store data for resolution
    overlay.dataset.conflicts = JSON.stringify(conflicts);
    overlay.dataset.newFromRemote = JSON.stringify(newFromRemote);
    overlay.dataset.localOnlyMeals = JSON.stringify(localOnlyMeals);

    overlay.classList.add('active');
}

// Resolve conflicts and continue sync
async function resolveConflicts() {
    const overlay = document.getElementById('conflictOverlay');
    const conflicts = JSON.parse(overlay.dataset.conflicts || '[]');
    const newFromRemote = JSON.parse(overlay.dataset.newFromRemote || '[]');
    const localOnlyMeals = JSON.parse(overlay.dataset.localOnlyMeals || '[]');

    const resolvedConflicts = [];

    conflicts.forEach((conflict, index) => {
        const choice = document.querySelector(`input[name="conflict_${index}"]:checked`).value;
        resolvedConflicts.push({
            syncId: conflict.local.syncId,
            choice: choice,
            local: conflict.local,
            remote: conflict.remote
        });
    });

    overlay.classList.remove('active');

    // Perform the merge with resolved conflicts
    await performMerge(newFromRemote, localOnlyMeals, resolvedConflicts);
}

// Cancel conflict resolution - keep local data only
function cancelConflictResolution() {
    const overlay = document.getElementById('conflictOverlay');
    overlay.classList.remove('active');
    isSyncing = false;

    updateSyncStatus('synced', localStorage.getItem('mealLogger_sheetName') || 'Google Sheets');
    showToast('Sync cancelled - local data unchanged', 'success');
}

async function loadFromSheet() {
    if (!selectedSheetId || !accessToken) return;

    try {
        updateSyncStatus('syncing', 'Loading data...');

        const response = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: selectedSheetId,
            range: 'Meals!A2:L10000'
        });

        const rows = response.result.values || [];

        if (rows.length === 0) {
            showToast('No data found in spreadsheet', 'error');
            updateSyncStatus('synced');
            return;
        }

        await clearAllMeals();

        let importCount = 0;
        for (const row of rows) {
            if (row[2]) {
                const meal = {
                    date: row[1] || formatDate(new Date()),
                    name: row[2] || '',
                    type: row[3] || 'snack',
                    calories: parseInt(row[4]) || 0,
                    protein: parseInt(row[5]) || 0,
                    carbs: parseInt(row[6]) || 0,
                    fat: parseInt(row[7]) || 0,
                    sugar: parseInt(row[8]) || 0,
                    notes: row[9] || '',
                    syncId: row[10] || generateSyncId(),
                    modifiedAt: row[11] || new Date().toISOString(),
                    timestamp: new Date().toISOString()
                };
                await addMeal(meal);
                importCount++;
            }
        }

        await loadMeals();
        localStorage.setItem('mealLogger_lastSync', new Date().toISOString());
        const sheetName = localStorage.getItem('mealLogger_sheetName') || 'Google Sheets';
        updateSyncStatus('synced', sheetName);
        showToast(`Loaded ${importCount} meals`, 'success');
    } catch (error) {
        console.error('Error loading from sheet:', error);
        updateSyncStatus('error');
        showToast('Failed to load data', 'error');
    }
}

function updateSyncStatus(status, sheetName = '') {
    const statusEl = document.getElementById('syncStatus');
    const indicatorEl = document.getElementById('syncIndicator');
    const textEl = document.getElementById('syncText');

    if (status === 'hidden') {
        statusEl.classList.add('hidden');
        return;
    }

    statusEl.classList.remove('hidden');
    indicatorEl.classList.remove('syncing', 'error');

    switch (status) {
        case 'syncing':
            indicatorEl.classList.add('syncing');
            textEl.textContent = sheetName || 'Syncing...';
            break;
        case 'synced':
            textEl.textContent = sheetName ? `Synced: ${sheetName}` : 'Synced';
            break;
        case 'error':
            indicatorEl.classList.add('error');
            textEl.textContent = 'Sync error';
            break;
    }
}

function showToast(message, type = '') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast show ' + type;

    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// IndexedDB initialization
function initDB() {
    return new Promise((resolve, reject) => {
        // Safari fix: Check if IndexedDB is available
        if (!window.indexedDB) {
            console.error('IndexedDB not supported');
            reject(new Error('IndexedDB not supported'));
            return;
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            console.error('Database error:', event.target.error);
            reject(event.target.error);
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('Database opened successfully');

            // Safari fix: Handle database close events
            db.onclose = () => {
                console.log('Database connection closed');
                db = null;
            };

            db.onerror = (event) => {
                console.error('Database error:', event.target.error);
            };

            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            console.log('Database upgrade needed');
            const database = event.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                const store = database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                store.createIndex('date', 'date', { unique: false });
                store.createIndex('type', 'type', { unique: false });
                console.log('Object store created');
            }
        };

        // Safari fix: Handle blocked events
        request.onblocked = () => {
            console.warn('Database blocked - close other tabs');
        };
    });
}

// Date utilities
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatDisplayDate(date) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const compareDate = new Date(date);
    compareDate.setHours(0, 0, 0, 0);

    if (compareDate.getTime() === today.getTime()) {
        return 'Today';
    } else if (compareDate.getTime() === yesterday.getTime()) {
        return 'Yesterday';
    } else if (compareDate.getTime() === tomorrow.getTime()) {
        return 'Tomorrow';
    } else {
        return date.toLocaleDateString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric'
        });
    }
}

function updateDateDisplay() {
    document.getElementById('currentDate').textContent = formatDisplayDate(currentDate);
    // Also update the analytics header to show selected date
    const analyticsHeader = document.getElementById('analyticsDailyCalories');
    if (analyticsHeader) {
        const dateLabel = document.querySelector('#dailyAnalytics .analytics-card:first-child h3');
        if (dateLabel) {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const selected = new Date(currentDate);
            selected.setHours(0, 0, 0, 0);

            if (selected.getTime() === today.getTime()) {
                dateLabel.textContent = "Today's Intake";
            } else {
                dateLabel.textContent = `${formatDisplayDate(currentDate)}'s Intake`;
            }
        }
    }
}

// Database operations
function getMealsByDate(date) {
    return new Promise((resolve, reject) => {
        // Safari fix: ensure db is ready
        if (!db) {
            console.error('Database not initialized');
            resolve([]);
            return;
        }

        try {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const dateStr = formatDate(date);
            console.log('Querying meals for date:', dateStr);

            // Safari fix: Use cursor instead of index.getAll for better compatibility
            const meals = [];
            const request = store.openCursor();

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    if (cursor.value.date === dateStr) {
                        meals.push(cursor.value);
                    }
                    cursor.continue();
                } else {
                    console.log('Query result:', meals);
                    resolve(meals);
                }
            };

            request.onerror = () => {
                console.error('Cursor error:', request.error);
                reject(request.error);
            };

            // Safari fix: Handle transaction errors
            transaction.onerror = () => {
                console.error('Transaction error:', transaction.error);
                reject(transaction.error);
            };
        } catch (error) {
            console.error('getMealsByDate error:', error);
            resolve([]);
        }
    });
}

function getAllMeals() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function clearAllMeals() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.clear();

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

function addMeal(meal) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.add(meal);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function updateMeal(meal) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(meal);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function deleteMeal(id) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(id);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

function getMealById(id) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(id);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// UI rendering
async function loadMeals() {
    try {
        const dateStr = formatDate(currentDate);
        console.log('Loading meals for date:', dateStr);
        const meals = await getMealsByDate(currentDate);
        console.log('Found meals:', meals.length, meals);
        renderMeals(meals);
        updateSummary(meals);
        updateDailyAnalytics(meals);
        return meals;
    } catch (error) {
        console.error('Error in loadMeals:', error);
        renderMeals([]);
        updateSummary([]);
        updateDailyAnalytics([]);
        return [];
    }
}

function renderMeals(meals) {
    const container = document.getElementById('mealsContainer');

    if (!container) {
        console.error('mealsContainer not found');
        return;
    }

    if (meals.length === 0) {
        // Use innerHTML instead of appendChild for Safari compatibility
        container.innerHTML = `
            <div class="empty-state" id="emptyState">
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M18.06 22.99h1.66c.84 0 1.53-.64 1.63-1.46L23 5.05l-5 2.18V22.99h.06zM1 21.99V8.97l5-2.19v15.21l-5 .00zM11 2L6.49 4.18v16.82L11 22.99 15.51 21V4.18L11 2zm3.51 6.03l-3.51 1.54-3.51-1.54v-2l3.51 1.54 3.51-1.54v2z"/>
                </svg>
                <p>No meals logged for this day</p>
                <p style="font-size: 0.85rem;">Tap + to add your first meal</p>
            </div>
        `;
        return;
    }

    const mealTypes = ['breakfast', 'lunch', 'dinner', 'snack'];
    const groupedMeals = {};

    mealTypes.forEach(type => {
        groupedMeals[type] = meals.filter(m => m.type === type);
    });

    let html = '';

    mealTypes.forEach(type => {
        if (groupedMeals[type].length > 0) {
            const emoji = type === 'breakfast' ? '🌅' : type === 'lunch' ? '☀️' : type === 'dinner' ? '🌙' : '🍎';
            html += `
                <div class="meal-section">
                    <h2>${emoji} ${type.charAt(0).toUpperCase() + type.slice(1)}</h2>
                    ${groupedMeals[type].map(meal => renderMealCard(meal)).join('')}
                </div>
            `;
        }
    });

    container.innerHTML = html;
}

function renderMealCard(meal) {
    const calories = meal.calories || 0;
    const macros = [];
    if (meal.protein) macros.push(`${meal.protein}g P`);
    if (meal.carbs) macros.push(`${meal.carbs}g C`);
    if (meal.fat) macros.push(`${meal.fat}g F`);
    if (meal.sugar) macros.push(`${meal.sugar}g S`);

    return `
        <div class="meal-card" data-id="${meal.id}">
            <div class="meal-info">
                <h3>${escapeHtml(meal.name)}</h3>
                <p>${macros.length > 0 ? macros.join(' • ') : 'No macros logged'}</p>
            </div>
            <div class="meal-calories">${calories}</div>
            <div class="meal-actions">
                <button onclick="editMeal(${meal.id})" title="Edit">✏️</button>
                <button onclick="confirmDelete(${meal.id})" title="Delete">🗑️</button>
            </div>
        </div>
    `;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function updateSummary(meals) {
    const totals = meals.reduce((acc, meal) => {
        acc.calories += meal.calories || 0;
        acc.protein += meal.protein || 0;
        acc.carbs += meal.carbs || 0;
        acc.fat += meal.fat || 0;
        acc.sugar += meal.sugar || 0;
        return acc;
    }, { calories: 0, protein: 0, carbs: 0, fat: 0, sugar: 0 });

    document.getElementById('totalCalories').textContent = totals.calories;
    document.getElementById('totalProtein').textContent = `${totals.protein}g`;
    document.getElementById('totalCarbs').textContent = `${totals.carbs}g`;
    document.getElementById('totalFat').textContent = `${totals.fat}g`;
    document.getElementById('totalSugar').textContent = `${totals.sugar}g`;
}

// Analytics functions
function updateDailyAnalytics(meals) {
    const totals = meals.reduce((acc, meal) => {
        acc.calories += meal.calories || 0;
        acc.protein += meal.protein || 0;
        acc.carbs += meal.carbs || 0;
        acc.fat += meal.fat || 0;
        acc.sugar += meal.sugar || 0;
        return acc;
    }, { calories: 0, protein: 0, carbs: 0, fat: 0, sugar: 0 });

    // Update big number
    document.getElementById('analyticsDailyCalories').textContent = totals.calories;

    // Update macro bars
    const maxMacro = Math.max(totals.protein, totals.carbs, totals.fat, totals.sugar, 1);

    document.getElementById('proteinBar').style.width = `${(totals.protein / maxMacro) * 100}%`;
    document.getElementById('proteinBarValue').textContent = `${totals.protein}g`;

    document.getElementById('carbsBar').style.width = `${(totals.carbs / maxMacro) * 100}%`;
    document.getElementById('carbsBarValue').textContent = `${totals.carbs}g`;

    document.getElementById('fatBar').style.width = `${(totals.fat / maxMacro) * 100}%`;
    document.getElementById('fatBarValue').textContent = `${totals.fat}g`;

    document.getElementById('sugarBar').style.width = `${(totals.sugar / maxMacro) * 100}%`;
    document.getElementById('sugarBarValue').textContent = `${totals.sugar}g`;

    // Update meals by type count
    const typeCounts = { breakfast: 0, lunch: 0, dinner: 0, snack: 0 };
    meals.forEach(meal => {
        if (typeCounts[meal.type] !== undefined) {
            typeCounts[meal.type]++;
        }
    });

    document.getElementById('breakfastCount').textContent = typeCounts.breakfast;
    document.getElementById('lunchCount').textContent = typeCounts.lunch;
    document.getElementById('dinnerCount').textContent = typeCounts.dinner;
    document.getElementById('snackCount').textContent = typeCounts.snack;

    // Update pie chart
    drawMacroPieChart(totals);

    // Update targets progress
    updateTargetsProgress(totals);

    // Update the date label
    updateDateDisplay();
}

// Draw pie chart showing calories by macro
function drawMacroPieChart(totals) {
    const canvas = document.getElementById('macroPieChart');
    if (!canvas) {
        console.log('Pie chart canvas not found');
        return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
        console.log('Could not get canvas context');
        return;
    }

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = Math.min(centerX, centerY) - 10;

    // Calculate calories from each macro
    const proteinCal = (totals.protein || 0) * 4;
    const carbsCal = (totals.carbs || 0) * 4;
    const fatCal = (totals.fat || 0) * 9;
    const totalMacroCal = proteinCal + carbsCal + fatCal;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Update legend elements
    const proteinPercentEl = document.getElementById('proteinCalPercent');
    const carbsPercentEl = document.getElementById('carbsCalPercent');
    const fatPercentEl = document.getElementById('fatCalPercent');

    if (totalMacroCal === 0) {
        // Draw empty state
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
        ctx.fillStyle = '#2a2a2a';
        ctx.fill();

        ctx.fillStyle = '#666';
        ctx.font = '14px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('No data', centerX, centerY);

        // Update legend
        if (proteinPercentEl) proteinPercentEl.textContent = '0%';
        if (carbsPercentEl) carbsPercentEl.textContent = '0%';
        if (fatPercentEl) fatPercentEl.textContent = '0%';
        return;
    }

    // Calculate percentages
    const proteinPercent = Math.round((proteinCal / totalMacroCal) * 100);
    const carbsPercent = Math.round((carbsCal / totalMacroCal) * 100);
    const fatPercent = 100 - proteinPercent - carbsPercent;

    // Update legend
    if (proteinPercentEl) proteinPercentEl.textContent = `${proteinPercent}%`;
    if (carbsPercentEl) carbsPercentEl.textContent = `${carbsPercent}%`;
    if (fatPercentEl) fatPercentEl.textContent = `${fatPercent}%`;

    // Colors matching CSS variables
    const colors = {
        protein: '#6c5ce7',
        carbs: '#fdcb6e',
        fat: '#e17055'
    };

    // Draw pie slices
    const data = [
        { value: proteinCal, color: colors.protein },
        { value: carbsCal, color: colors.carbs },
        { value: fatCal, color: colors.fat }
    ];

    let startAngle = -Math.PI / 2; // Start from top

    data.forEach(slice => {
        if (slice.value > 0) {
            const sliceAngle = (slice.value / totalMacroCal) * 2 * Math.PI;

            ctx.beginPath();
            ctx.moveTo(centerX, centerY);
            ctx.arc(centerX, centerY, radius, startAngle, startAngle + sliceAngle);
            ctx.closePath();
            ctx.fillStyle = slice.color;
            ctx.fill();

            startAngle += sliceAngle;
        }
    });

    // Draw center circle for donut effect
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius * 0.55, 0, 2 * Math.PI);
    ctx.fillStyle = '#1a1a1a';
    ctx.fill();

    // Draw total calories in center
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(totalMacroCal, centerX, centerY - 8);

    ctx.fillStyle = '#888';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText('cal', centerX, centerY + 12);
}

// Update targets progress bars
function updateTargetsProgress(totals) {
    const targets = getMacroTargets();

    // Calculate calories from targets (protein*4 + carbs*4 + fat*9)
    const targetCalories = (targets.protein * 4) + (targets.carbs * 4) + (targets.fat * 9);
    const actualCalories = (totals.protein * 4) + (totals.carbs * 4) + (totals.fat * 9);

    // Update calorie summary
    const calSummary = document.getElementById('targetCaloriesSummary');
    const hasTargets = targets.protein || targets.carbs || targets.fat || targets.sugar;

    if (calSummary) {
        if (hasTargets && targetCalories > 0) {
            calSummary.style.display = 'block';
            document.getElementById('actualTotalCal').textContent = actualCalories;
            document.getElementById('targetTotalCal').textContent = targetCalories;

            // Update calorie bar
            const calBar = document.getElementById('totalCalBar');
            if (calBar) {
                const calPercent = Math.min((actualCalories / targetCalories) * 100, 100);
                calBar.style.width = `${calPercent}%`;
                if (actualCalories > targetCalories) {
                    calBar.classList.add('over-target');
                } else {
                    calBar.classList.remove('over-target');
                }
            }
        } else {
            calSummary.style.display = 'none';
        }
    }

    // Update protein
    document.getElementById('proteinActual').textContent = totals.protein;
    document.getElementById('proteinTarget').textContent = targets.protein || '--';
    updateTargetBar('proteinTargetBar', totals.protein, targets.protein);

    // Update carbs
    document.getElementById('carbsActual').textContent = totals.carbs;
    document.getElementById('carbsTarget').textContent = targets.carbs || '--';
    updateTargetBar('carbsTargetBar', totals.carbs, targets.carbs);

    // Update fat
    document.getElementById('fatActual').textContent = totals.fat;
    document.getElementById('fatTarget').textContent = targets.fat || '--';
    updateTargetBar('fatTargetBar', totals.fat, targets.fat);

    // Update sugar
    document.getElementById('sugarActual').textContent = totals.sugar;
    document.getElementById('sugarTarget').textContent = targets.sugar || '--';
    updateTargetBar('sugarTargetBar', totals.sugar, targets.sugar);

    // Show/hide hint
    const hint = document.getElementById('targetsHint');
    if (hint) {
        hint.style.display = hasTargets ? 'none' : 'block';
    }
}

function updateTargetBar(barId, actual, target) {
    const bar = document.getElementById(barId);
    if (!bar) return;

    if (!target) {
        bar.style.width = '0%';
        return;
    }

    const percentage = Math.min((actual / target) * 100, 100);
    bar.style.width = `${percentage}%`;

    // Add over-target indicator if exceeded
    if (actual > target) {
        bar.style.width = '100%';
        bar.classList.add('over-target');
    } else {
        bar.classList.remove('over-target');
    }
}

// Get macro targets from localStorage
function getMacroTargets() {
    return {
        protein: parseInt(localStorage.getItem('mealLogger_targetProtein')) || 0,
        carbs: parseInt(localStorage.getItem('mealLogger_targetCarbs')) || 0,
        fat: parseInt(localStorage.getItem('mealLogger_targetFat')) || 0,
        sugar: parseInt(localStorage.getItem('mealLogger_targetSugar')) || 0
    };
}

// Save macro targets to localStorage and Google Sheets
async function saveMacroTargets() {
    const protein = parseInt(document.getElementById('targetProtein').value) || 0;
    const carbs = parseInt(document.getElementById('targetCarbs').value) || 0;
    const fat = parseInt(document.getElementById('targetFat').value) || 0;
    const sugar = parseInt(document.getElementById('targetSugar').value) || 0;

    // Save to localStorage
    localStorage.setItem('mealLogger_targetProtein', protein.toString());
    localStorage.setItem('mealLogger_targetCarbs', carbs.toString());
    localStorage.setItem('mealLogger_targetFat', fat.toString());
    localStorage.setItem('mealLogger_targetSugar', sugar.toString());

    // Sync to Google Sheets if connected
    if (selectedSheetId && accessToken) {
        await syncTargetsToSheet({ protein, carbs, fat, sugar });
    }

    showToast('Targets saved!', 'success');

    // Update the preview with saved values
    updateTargetCaloriesPreview();

    // Refresh analytics to show updated targets
    loadMeals();
}

// Update calories preview in real-time as user types
function updateTargetCaloriesPreview() {
    const protein = parseInt(document.getElementById('targetProtein').value) || 0;
    const carbs = parseInt(document.getElementById('targetCarbs').value) || 0;
    const fat = parseInt(document.getElementById('targetFat').value) || 0;

    const proteinCal = protein * 4;
    const carbsCal = carbs * 4;
    const fatCal = fat * 9;
    const totalCal = proteinCal + carbsCal + fatCal;

    document.getElementById('calcTargetCalories').textContent = totalCal;
    document.getElementById('calcProteinCal').textContent = proteinCal;
    document.getElementById('calcCarbsCal').textContent = carbsCal;
    document.getElementById('calcFatCal').textContent = fatCal;
}

// Claude API key management
function saveClaudeApiKey() {
    const apiKey = document.getElementById('claudeApiKey').value.trim();
    if (apiKey) {
        localStorage.setItem('mealLogger_claudeApiKey', apiKey);
        showToast('API key saved!', 'success');
    } else {
        localStorage.removeItem('mealLogger_claudeApiKey');
        showToast('API key removed', 'success');
    }
}

function getClaudeApiKey() {
    return localStorage.getItem('mealLogger_claudeApiKey') || '';
}

function loadClaudeApiKeyIntoForm() {
    const apiKey = getClaudeApiKey();
    const input = document.getElementById('claudeApiKey');
    if (input && apiKey) {
        input.value = apiKey;
    }
}

// Photo upload and analysis
function handlePhotoSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
        showToast('Please select an image file', 'error');
        return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
        showToast('Image too large. Max 5MB.', 'error');
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        selectedPhotoBase64 = e.target.result;

        // Show preview
        const preview = document.getElementById('photoPreview');
        const previewImg = document.getElementById('previewImage');
        const uploadBtn = document.getElementById('photoUploadBtn');
        const descContainer = document.getElementById('photoDescContainer');

        previewImg.src = selectedPhotoBase64;
        preview.style.display = 'block';
        uploadBtn.style.display = 'none';
        descContainer.style.display = 'flex';
    };
    reader.readAsDataURL(file);
}

function removePhoto() {
    selectedPhotoBase64 = null;
    document.getElementById('foodPhoto').value = '';
    document.getElementById('photoPreview').style.display = 'none';
    document.getElementById('photoUploadBtn').style.display = 'flex';
    document.getElementById('photoDescContainer').style.display = 'none';
    document.getElementById('photoDescription').value = '';
}

async function analyzePhotoWithClaude() {
    const apiKey = getClaudeApiKey();
    if (!apiKey) {
        showToast('Please add your Claude API key in Settings', 'error');
        return;
    }

    if (!selectedPhotoBase64) {
        showToast('Please select a photo first', 'error');
        return;
    }

    const description = document.getElementById('photoDescription').value.trim();
    const loadingEl = document.getElementById('analysisLoading');
    const analyzeBtn = document.getElementById('analyzePhotoBtn');

    // Show loading state
    loadingEl.style.display = 'flex';
    analyzeBtn.disabled = true;

    try {
        // Extract base64 data (remove data:image/...;base64, prefix)
        const base64Data = selectedPhotoBase64.split(',')[1];
        const mediaType = selectedPhotoBase64.split(';')[0].split(':')[1];

        const prompt = `Analyze this food image and estimate the nutritional macros.
${description ? `Additional context: ${description}` : ''}

Please respond with ONLY a JSON object in this exact format, no other text:
{
  "name": "Brief name of the food/meal",
  "protein": estimated protein in grams (number),
  "carbs": estimated carbs in grams (number),
  "fat": estimated fat in grams (number),
  "sugar": estimated sugar in grams (number),
  "confidence": "low" | "medium" | "high",
  "notes": "Brief note about the estimation"
}`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 500,
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: mediaType,
                                data: base64Data
                            }
                        },
                        {
                            type: 'text',
                            text: prompt
                        }
                    ]
                }]
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error?.message || 'API request failed');
        }

        const data = await response.json();
        const content = data.content[0].text;

        // Parse the JSON response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('Could not parse AI response');
        }

        const macros = JSON.parse(jsonMatch[0]);

        // Fill in the form
        document.getElementById('mealName').value = macros.name || '';
        document.getElementById('protein').value = Math.round(macros.protein) || 0;
        document.getElementById('carbs').value = Math.round(macros.carbs) || 0;
        document.getElementById('fat').value = Math.round(macros.fat) || 0;
        document.getElementById('sugar').value = Math.round(macros.sugar) || 0;

        // Update calories
        calculateCalories();

        // Add confidence note
        const notes = document.getElementById('notes');
        const confidenceNote = `AI estimate (${macros.confidence} confidence)${macros.notes ? ': ' + macros.notes : ''}`;
        notes.value = confidenceNote;

        showToast('Macros estimated successfully!', 'success');

    } catch (error) {
        console.error('Error analyzing photo:', error);
        showToast(`Analysis failed: ${error.message}`, 'error');
    } finally {
        loadingEl.style.display = 'none';
        analyzeBtn.disabled = false;
    }
}

// Load saved targets into settings form
function loadMacroTargetsIntoForm() {
    const targets = getMacroTargets();

    const proteinInput = document.getElementById('targetProtein');
    const carbsInput = document.getElementById('targetCarbs');
    const fatInput = document.getElementById('targetFat');
    const sugarInput = document.getElementById('targetSugar');

    if (proteinInput) proteinInput.value = targets.protein || '';
    if (carbsInput) carbsInput.value = targets.carbs || '';
    if (fatInput) fatInput.value = targets.fat || '';
    if (sugarInput) sugarInput.value = targets.sugar || '';

    // Update calories preview with loaded values (use setTimeout to ensure DOM updates)
    setTimeout(updateTargetCaloriesPreview, 0);
}

// Sync targets to Google Sheets (Settings tab)
async function syncTargetsToSheet(targets) {
    if (!selectedSheetId || !accessToken) return;

    try {
        // First, ensure the Settings sheet exists
        await ensureSettingsSheet();

        // Write targets to Settings sheet
        await gapi.client.sheets.spreadsheets.values.update({
            spreadsheetId: selectedSheetId,
            range: 'Settings!A1:B5',
            valueInputOption: 'RAW',
            resource: {
                values: [
                    ['Setting', 'Value'],
                    ['targetProtein', targets.protein || 0],
                    ['targetCarbs', targets.carbs || 0],
                    ['targetFat', targets.fat || 0],
                    ['targetSugar', targets.sugar || 0]
                ]
            }
        });

        console.log('Targets synced to Google Sheets');
    } catch (error) {
        console.error('Error syncing targets to sheet:', error);
    }
}

// Load targets from Google Sheets
async function loadTargetsFromSheet() {
    if (!selectedSheetId || !accessToken) return null;

    try {
        const response = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: selectedSheetId,
            range: 'Settings!A2:B5'
        });

        const rows = response.result.values || [];
        const targets = {};

        rows.forEach(row => {
            if (row[0] && row[1]) {
                targets[row[0]] = parseInt(row[1]) || 0;
            }
        });

        return {
            protein: targets.targetProtein || 0,
            carbs: targets.targetCarbs || 0,
            fat: targets.targetFat || 0,
            sugar: targets.targetSugar || 0
        };
    } catch (error) {
        console.log('Could not load targets from sheet:', error);
        return null;
    }
}

// Ensure Settings sheet exists in the spreadsheet
async function ensureSettingsSheet() {
    if (!selectedSheetId || !accessToken) return;

    try {
        // Get spreadsheet info to check existing sheets
        const response = await gapi.client.sheets.spreadsheets.get({
            spreadsheetId: selectedSheetId
        });

        const sheets = response.result.sheets || [];
        const hasSettingsSheet = sheets.some(sheet => sheet.properties.title === 'Settings');

        if (!hasSettingsSheet) {
            // Create Settings sheet
            await gapi.client.sheets.spreadsheets.batchUpdate({
                spreadsheetId: selectedSheetId,
                resource: {
                    requests: [{
                        addSheet: {
                            properties: {
                                title: 'Settings'
                            }
                        }
                    }]
                }
            });
            console.log('Settings sheet created');
        }
    } catch (error) {
        console.error('Error ensuring Settings sheet:', error);
    }
}

async function updateWeeklyAnalytics() {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - dayOfWeek);
    startOfWeek.setHours(0, 0, 0, 0);

    const allMeals = await getAllMeals();
    const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const weekData = [];

    let totalCalories = 0;
    let totalMeals = 0;
    let totalProtein = 0;
    let totalSugar = 0;
    let daysWithData = 0;

    for (let i = 0; i < 7; i++) {
        const date = new Date(startOfWeek);
        date.setDate(startOfWeek.getDate() + i);
        const dateStr = formatDate(date);

        const dayMeals = allMeals.filter(m => m.date === dateStr);
        const dayCalories = dayMeals.reduce((sum, m) => sum + (m.calories || 0), 0);
        const dayProtein = dayMeals.reduce((sum, m) => sum + (m.protein || 0), 0);
        const daySugar = dayMeals.reduce((sum, m) => sum + (m.sugar || 0), 0);

        weekData.push({
            day: weekDays[i],
            calories: dayCalories,
            isToday: formatDate(date) === formatDate(today),
            hasData: dayMeals.length > 0
        });

        totalCalories += dayCalories;
        totalMeals += dayMeals.length;
        totalProtein += dayProtein;
        totalSugar += daySugar;
        if (dayMeals.length > 0) daysWithData++;
    }

    // Update weekly average
    const avgCalories = daysWithData > 0 ? Math.round(totalCalories / daysWithData) : 0;
    document.getElementById('weeklyAvgCalories').textContent = avgCalories;

    // Update week day grid
    const gridHtml = weekData.map(day => `
        <div class="week-day ${day.isToday ? 'today' : ''} ${day.hasData ? 'has-data' : ''}">
            <div class="week-day-name">${day.day}</div>
            <div class="week-day-value">${day.calories}</div>
        </div>
    `).join('');
    document.getElementById('weekDayGrid').innerHTML = gridHtml;

    // Update weekly totals
    document.getElementById('weeklyTotalCalories').textContent = totalCalories;
    document.getElementById('weeklyTotalMeals').textContent = totalMeals;
    document.getElementById('weeklyTotalProtein').textContent = `${totalProtein}g`;
    document.getElementById('weeklyTotalSugar').textContent = `${totalSugar}g`;
}

// Modal handling
function openModal(isEdit = false) {
    document.getElementById('modalOverlay').classList.add('active');
    document.getElementById('modalTitle').textContent = isEdit ? 'Edit Meal' : 'Add Meal';
    document.getElementById('submitBtn').textContent = isEdit ? 'Save Changes' : 'Add Meal';

    if (!isEdit) {
        document.getElementById('calories').value = 0;
    }
}

function closeModal() {
    document.getElementById('modalOverlay').classList.remove('active');
    document.getElementById('mealForm').reset();
    document.getElementById('mealId').value = '';
    document.getElementById('calories').value = 0;

    // Reset photo state
    removePhoto();
}

function openSettings() {
    document.getElementById('settingsOverlay').classList.add('active');
    loadMacroTargetsIntoForm();
    loadClaudeApiKeyIntoForm();
}

function closeSettings() {
    document.getElementById('settingsOverlay').classList.remove('active');
}

async function editMeal(id) {
    const meal = await getMealById(id);
    if (meal) {
        document.getElementById('mealId').value = meal.id;
        document.getElementById('mealName').value = meal.name;
        document.getElementById('mealType').value = meal.type;
        document.getElementById('calories').value = meal.calories || 0;
        document.getElementById('protein').value = meal.protein || '';
        document.getElementById('carbs').value = meal.carbs || '';
        document.getElementById('fat').value = meal.fat || '';
        document.getElementById('sugar').value = meal.sugar || '';
        document.getElementById('notes').value = meal.notes || '';
        openModal(true);
    }
}

async function confirmDelete(id) {
    if (confirm('Are you sure you want to delete this meal?')) {
        await deleteMeal(id);
        await loadMeals();

        // Auto-sync to Google Sheets
        if (selectedSheetId && accessToken) {
            smartSync();
        }
    }
}

// Form submission
async function handleSubmit(e) {
    e.preventDefault();

    const id = document.getElementById('mealId').value;
    const now = new Date().toISOString();

    const meal = {
        name: document.getElementById('mealName').value.trim(),
        type: document.getElementById('mealType').value,
        calories: parseInt(document.getElementById('calories').value) || 0,
        protein: parseInt(document.getElementById('protein').value) || 0,
        carbs: parseInt(document.getElementById('carbs').value) || 0,
        fat: parseInt(document.getElementById('fat').value) || 0,
        sugar: parseInt(document.getElementById('sugar').value) || 0,
        notes: document.getElementById('notes').value.trim(),
        date: formatDate(currentDate),
        timestamp: now,
        modifiedAt: now
    };

    if (id) {
        // Preserve syncId when editing
        const existingMeal = await getMealById(parseInt(id));
        meal.id = parseInt(id);
        meal.syncId = existingMeal?.syncId || generateSyncId();
        await updateMeal(meal);
    } else {
        // Generate new syncId for new meals
        meal.syncId = generateSyncId();
        await addMeal(meal);
    }

    closeModal();
    await loadMeals();

    // Auto-sync to Google Sheets
    if (selectedSheetId && accessToken) {
        smartSync();
    }
}

// Navigate to previous day
function goToPrevDay() {
    // Safari fix: Create date from timestamp to avoid timezone issues
    const timestamp = currentDate.getTime();
    const newDate = new Date(timestamp);
    newDate.setDate(newDate.getDate() - 1);
    currentDate = newDate;
    console.log('Changed to previous day:', formatDate(currentDate));
    updateDateDisplay();
    // Safari fix: Use setTimeout to ensure DOM is ready
    setTimeout(() => {
        loadMeals().catch(err => console.error('Error loading meals:', err));
    }, 0);
}

// Navigate to next day
function goToNextDay() {
    // Safari fix: Create date from timestamp to avoid timezone issues
    const timestamp = currentDate.getTime();
    const newDate = new Date(timestamp);
    newDate.setDate(newDate.getDate() + 1);
    currentDate = newDate;
    console.log('Changed to next day:', formatDate(currentDate));
    updateDateDisplay();
    // Safari fix: Use setTimeout to ensure DOM is ready
    setTimeout(() => {
        loadMeals().catch(err => console.error('Error loading meals:', err));
    }, 0);
}

// Event listeners setup
function setupEventListeners() {
    // Navigation - Day change
    document.getElementById('prevDay').addEventListener('click', goToPrevDay);
    document.getElementById('nextDay').addEventListener('click', goToNextDay);

    // Modal
    document.getElementById('addMealBtn').addEventListener('click', () => openModal());
    document.getElementById('closeModal').addEventListener('click', closeModal);
    document.getElementById('modalOverlay').addEventListener('click', (e) => {
        if (e.target === document.getElementById('modalOverlay')) {
            closeModal();
        }
    });

    // Settings
    document.getElementById('settingsBtn').addEventListener('click', openSettings);
    document.getElementById('closeSettings').addEventListener('click', closeSettings);
    document.getElementById('settingsOverlay').addEventListener('click', (e) => {
        if (e.target === document.getElementById('settingsOverlay')) {
            closeSettings();
        }
    });

    // Sheet actions
    document.getElementById('createNewSheet').addEventListener('click', createNewSheet);
    document.getElementById('loadFromSheet').addEventListener('click', loadFromSheet);
    document.getElementById('syncNowBtn').addEventListener('click', smartSync);

    // Macro targets
    document.getElementById('saveTargetsBtn').addEventListener('click', saveMacroTargets);

    // Real-time calorie calculation for target inputs
    ['targetProtein', 'targetCarbs', 'targetFat'].forEach(id => {
        document.getElementById(id).addEventListener('input', updateTargetCaloriesPreview);
    });

    // Claude API key
    document.getElementById('saveApiKeyBtn').addEventListener('click', saveClaudeApiKey);

    // Photo upload and analysis
    document.getElementById('photoUploadBtn').addEventListener('click', () => {
        document.getElementById('foodPhoto').click();
    });
    document.getElementById('foodPhoto').addEventListener('change', handlePhotoSelect);
    document.getElementById('removePhotoBtn').addEventListener('click', removePhoto);
    document.getElementById('analyzePhotoBtn').addEventListener('click', analyzePhotoWithClaude);

    // Form
    document.getElementById('mealForm').addEventListener('submit', handleSubmit);

    // PWA install prompt
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;

        setTimeout(() => {
            if (deferredPrompt) {
                document.getElementById('installPrompt').classList.add('show');
            }
        }, 3000);
    });

    document.getElementById('installApp').addEventListener('click', async () => {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            console.log(`User ${outcome} the install prompt`);
            deferredPrompt = null;
            document.getElementById('installPrompt').classList.remove('show');
        }
    });

    document.getElementById('dismissInstall').addEventListener('click', () => {
        document.getElementById('installPrompt').classList.remove('show');
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeModal();
            closeSettings();
        }
    });
}

// Service worker registration
async function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        try {
            const registration = await navigator.serviceWorker.register('sw.js');
            console.log('Service Worker registered:', registration.scope);
        } catch (error) {
            console.log('Service Worker registration failed:', error);
        }
    }
}

// Make functions available globally for onclick handlers
window.editMeal = editMeal;
window.confirmDelete = confirmDelete;
window.signIn = signIn;
window.signOut = signOut;
window.selectSheet = selectSheet;
window.createNewSheet = createNewSheet;
window.loadFromSheet = loadFromSheet;
window.syncToSheet = syncToSheet;
window.smartSync = smartSync;
window.resolveConflicts = resolveConflicts;
window.cancelConflictResolution = cancelConflictResolution;
window.calculateCalories = calculateCalories;
window.switchTab = switchTab;
window.switchAnalyticsSubTab = switchAnalyticsSubTab;
window.goToPrevDay = goToPrevDay;
window.goToNextDay = goToNextDay;
window.saveMacroTargets = saveMacroTargets;
