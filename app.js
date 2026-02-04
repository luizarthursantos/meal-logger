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

// Initialize the app
document.addEventListener('DOMContentLoaded', async () => {
    await initDB();
    updateDateDisplay();
    await loadMeals();
    setupEventListeners();
    registerServiceWorker();
    initGoogleAPI();
    loadSavedSettings();
});

// Load saved settings from localStorage
function loadSavedSettings() {
    const savedSheetId = localStorage.getItem('mealLogger_sheetId');
    const savedSheetName = localStorage.getItem('mealLogger_sheetName');
    const savedUser = localStorage.getItem('mealLogger_user');

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
    } catch (error) {
        console.error('Error initializing Google API client:', error);
    }
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
        loadUserSheets();
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

        await gapi.client.sheets.spreadsheets.values.clear({
            spreadsheetId: selectedSheetId,
            range: 'Meals!A2:J10000'
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
                meal.notes || ''
            ]);

            await gapi.client.sheets.spreadsheets.values.update({
                spreadsheetId: selectedSheetId,
                range: 'Meals!A2',
                valueInputOption: 'RAW',
                resource: { values: rows }
            });
        }

        const sheetName = localStorage.getItem('mealLogger_sheetName') || 'Google Sheets';
        updateSyncStatus('synced', sheetName);
        showToast('Synced to Google Sheets', 'success');
    } catch (error) {
        console.error('Error syncing to sheet:', error);
        updateSyncStatus('error');
        showToast('Sync failed', 'error');
    }
}

async function loadFromSheet() {
    if (!selectedSheetId || !accessToken) return;

    try {
        updateSyncStatus('syncing', 'Loading data...');

        const response = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: selectedSheetId,
            range: 'Meals!A2:J10000'
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
                    timestamp: new Date().toISOString()
                };
                await addMeal(meal);
                importCount++;
            }
        }

        await loadMeals();
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
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                const store = database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                store.createIndex('date', 'date', { unique: false });
                store.createIndex('type', 'type', { unique: false });
            }
        };
    });
}

// Date utilities
function formatDate(date) {
    return date.toISOString().split('T')[0];
}

function formatDisplayDate(date) {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    if (formatDate(date) === formatDate(today)) {
        return 'Today';
    } else if (formatDate(date) === formatDate(yesterday)) {
        return 'Yesterday';
    } else if (formatDate(date) === formatDate(tomorrow)) {
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
}

// Database operations
function getMealsByDate(date) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('date');
        const request = index.getAll(formatDate(date));

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
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
    console.log('Loading meals for date:', formatDate(currentDate));
    const meals = await getMealsByDate(currentDate);
    console.log('Found meals:', meals.length);
    renderMeals(meals);
    updateSummary(meals);
    updateDailyAnalytics(meals);
}

function renderMeals(meals) {
    const container = document.getElementById('mealsContainer');
    const emptyState = document.getElementById('emptyState');

    if (meals.length === 0) {
        container.innerHTML = '';
        container.appendChild(emptyState);
        emptyState.style.display = 'block';
        return;
    }

    emptyState.style.display = 'none';

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
}

function openSettings() {
    document.getElementById('settingsOverlay').classList.add('active');
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

        if (selectedSheetId && accessToken) {
            syncToSheet();
        }
    }
}

// Form submission
async function handleSubmit(e) {
    e.preventDefault();

    const id = document.getElementById('mealId').value;
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
        timestamp: new Date().toISOString()
    };

    if (id) {
        meal.id = parseInt(id);
        await updateMeal(meal);
    } else {
        await addMeal(meal);
    }

    closeModal();
    await loadMeals();

    if (selectedSheetId && accessToken) {
        syncToSheet();
    }
}

// Event listeners setup
function setupEventListeners() {
    // Navigation - Day change
    document.getElementById('prevDay').addEventListener('click', async () => {
        currentDate.setDate(currentDate.getDate() - 1);
        updateDateDisplay();
        await loadMeals();
        console.log('Changed to previous day:', formatDate(currentDate));
    });

    document.getElementById('nextDay').addEventListener('click', async () => {
        currentDate.setDate(currentDate.getDate() + 1);
        updateDateDisplay();
        await loadMeals();
        console.log('Changed to next day:', formatDate(currentDate));
    });

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
    document.getElementById('syncNowBtn').addEventListener('click', syncToSheet);

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
window.calculateCalories = calculateCalories;
window.switchTab = switchTab;
window.switchAnalyticsSubTab = switchAnalyticsSubTab;
