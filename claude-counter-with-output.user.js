// ==UserScript==
// @name         Claude Counter
// @namespace    Violentmonkey Scripts
// @match        https://claude.ai/*
// @version      1.0
// @author       lugia19
// @description  Counts tokens in chat messages
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
	'use strict';

	//#region Constants and Configuration
	const STORAGE_KEY = 'chatTokenCounter_v1';
	const MODEL_SELECTOR = '[data-testid="model-selector-dropdown"]';
	const POLL_INTERVAL_MS = 1000;
	const DELAY_MS = 100;
	const OUTPUT_TOKEN_MULTIPLIER = 10;	//How much to weigh output tokens.

	// Model-specific token limits
	const MODEL_TOKENS = {
		'3 Opus': 1500000,
		'3.5 Sonnet (New)': 2500000,
		'3 Haiku': 4000000,
		'default': 2500000
	};

	const MODELS = ['3 Haiku', '3.5 Sonnet (New)', '3 Opus'];
	const WARNING_THRESHOLD = 0.9;

	// Selectors and identifiers - unchanged
	const SELECTORS = {
		MAIN_INPUT: 'div[aria-label="Write your prompt to Claude"]',
		REGENERATE_BUTTON_PATH: 'M224,128a96,96,0,0,1-94.71,96H128A95.38,95.38,0,0,1,62.1,197.8a8,8,0,0,1,11-11.63A80,80,0,1,0,71.43,71.39a3.07,3.07,0,0,1-.26.25L44.59,96H72a8,8,0,0,1,0,16H24a8,8,0,0,1-8-8V56a8,8,0,0,1,16,0V85.8L60.25,60A96,96,0,0,1,224,128Z',
		SAVE_BUTTON: 'button[type="submit"]',
		EDIT_TEXTAREA: '.font-user-message textarea',
		USER_MESSAGE: '[data-testid="user-message"]',
		AI_MESSAGE: '.font-claude-message',
		SEND_BUTTON: 'button[aria-label="Send Message"]',
		SIDEBAR_BUTTON: '[data-testid="chat-controls"]',
		FILE_BUTTONS: 'button[data-testid="file-thumbnail"]',
		PROJECT_FILES_CONTAINER: '.border-border-400.rounded-lg.border',
		PROJECT_FILES: 'button[data-testid="file-thumbnail"]',
		MODAL: '[role="dialog"]',
		MODAL_CONTENT: '.whitespace-pre-wrap.break-all.text-xs',
		MODAL_CLOSE: 'button:has(svg path[d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"])',
		BACK_BUTTON: 'button:has(svg path[d="M224,128a8,8,0,0,1-8,8H59.31l58.35,58.34a8,8,0,0,1-11.32,11.32l-72-72a8,8,0,0,1,0-11.32l72-72a8,8,0,0,1,11.32,11.32L59.31,120H216A8,8,0,0,1,224,128Z"])',
		SIDEBAR_CONTENT: '.bg-bg-100.border-0\\.5.border-border-300.flex-1',
		FILE_VIEW_CONTAINER: '.flex.h-full.flex-col.pb-1.pl-5.pt-3',
		FILE_CONTENT: '.whitespace-pre-wrap.break-all.text-xs'
	};
	//#endregion

	//State variables
	let totalTokenCount = 0;
	let currentTokenCount = 0;
	let currentModel = getCurrentModel();
	let modelSections = {};


	//#region Utility Functions
	const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

	function getConversationId() {
		const match = window.location.pathname.match(/\/chat\/([^/?]+)/);
		return match ? match[1] : null;
	}

	function getCurrentModel() {
		const modelSelector = document.querySelector(MODEL_SELECTOR);
		if (!modelSelector) return 'default';

		const modelText = modelSelector.querySelector('.whitespace-nowrap')?.textContent?.trim() || 'default';
		return modelText;
	}

	async function waitForElement(selector, maxAttempts = 5) {
		let attempts = 0;
		while (attempts < maxAttempts) {
			const element = document.querySelector(selector);
			if (element) return element;

			await sleep(100);
			attempts++;
		}
		return null;
	}

	function formatTimeRemaining(resetTime) {
		const now = new Date();
		const diff = resetTime - now;

		if (diff <= 0) return 'Reset pending...';

		const hours = Math.floor(diff / (1000 * 60 * 60));
		const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

		if (hours > 0) {
			return `Reset in: ${hours}h ${minutes}m`;
		} else {
			return `Reset in: ${minutes}m`;
		}
	}

	function calculateTokens(text) {
		const charCount = text.length;
		return Math.ceil((charCount / 4) * 1.2);
	}

	function getResetTime(currentTime) {
		const hourStart = new Date(currentTime);
		hourStart.setMinutes(0, 0, 0);
		const resetTime = new Date(hourStart);
		resetTime.setHours(hourStart.getHours() + 5);
		return resetTime;
	}
	//#endregion

	//#region Storage Management
	function getStorageKey() {
		return `${STORAGE_KEY}_${currentModel.replace(/\s+/g, '_')}`;
	}

	function getFileStorageKey(filename, isProjectFile = false) {
		const conversationId = getConversationId();
		return `${STORAGE_KEY}_${isProjectFile ? 'project' : 'content'}_${conversationId}_${filename}`;
	}

	function initializeOrLoadStorage() {
		const stored = GM_getValue(getStorageKey());

		if (stored) {
			const currentTime = new Date();
			const resetTime = new Date(stored.resetTimestamp);

			if (currentTime >= resetTime) {
				return { total: 0, isInitialized: false };
			} else {
				return { total: stored.total, isInitialized: true };
			}
		}
		return { total: 0, isInitialized: false };
	}

	function saveToStorage(count) {
		const currentTime = new Date();
		const { isInitialized } = initializeOrLoadStorage();
		console.log(`Saving count to ${getStorageKey()}!`)
		if (!isInitialized) {
			const resetTime = getResetTime(currentTime);
			GM_setValue(getStorageKey(), {
				total: count,
				resetTimestamp: resetTime.getTime()
			});
		} else {
			const existing = GM_getValue(getStorageKey());
			GM_setValue(getStorageKey(), {
				total: count,
				resetTimestamp: existing.resetTimestamp
			});
		}
	}
	//#endregion

	//#region Project/Chat File Processing
	async function ensureSidebarLoaded() {
		const sidebar = document.querySelector(SELECTORS.SIDEBAR_CONTENT);

		// If sidebar exists and has been processed before, we're done
		if (sidebar && sidebar.getAttribute('data-files-processed')) {
			console.log("Sidebar was processed! Skipping opening it.")
			return true;
		}

		// If we get here, we need to open/reload the sidebar
		const sidebarButton = document.querySelector(SELECTORS.SIDEBAR_BUTTON);
		if (!sidebarButton) {
			console.log('Could not find sidebar button');
			return false;
		}

		sidebarButton.click();


		// Wait for sidebar to become visible and mark it as processed
		let attempts = 0;
		while (attempts < 5) {
			let sidebar = document.querySelector(SELECTORS.SIDEBAR_CONTENT);
			if (sidebar) {
				const style = window.getComputedStyle(sidebar);
				if (style.opacity !== '0' && !style.transform.includes('translateX(100%)')) {
					console.log("Sidebar is visible, wait 1 sec.")
					sidebar.setAttribute('data-files-processed', 'true');
					await sleep(1000);

					//Ensure we have actually updated data.
					sidebar = document.querySelector(SELECTORS.SIDEBAR_CONTENT);

					// Close the sidebar since we only needed it to load the content
					const closeButton = document.querySelector('button[data-testid="close-file-preview"]');
					if (closeButton) {
						closeButton.click();
					}

					return true;
				}
			}
			await sleep(100);
			attempts++;
		}
		console.log('Sidebar did not show/load properly');
		return false;
	}

	async function getProjectFileTokens(button) {
		try {
			const fileContainer = button.closest('div[data-testid]');
			if (!fileContainer) {
				console.log('Could not find project file container');
				return 0;
			}

			const filename = fileContainer.getAttribute('data-testid');
			console.log('Processing project file:', filename);

			const storageKey = getFileStorageKey(filename, true);
			const stored = GM_getValue(storageKey);
			if (stored !== undefined) {
				//console.log(`Using cached tokens for project file: ${filename}`);
				//return stored;
			}

			console.log(`Calculating tokens for project file: ${filename}`);
			button.click();

			// Wait for modal with correct filename
			let attempts = 0;
			let modal = null;
			let modalTitle = null;

			while (attempts < 5) {
				modal = document.querySelector(SELECTORS.MODAL);
				if (modal) {
					modalTitle = modal.querySelector('h2');
					if (modalTitle && modalTitle.textContent === filename) {
						console.log(`Found modal with title ${filename}`)
						break;
					}
				}
				await new Promise(resolve => setTimeout(resolve, 200));
				attempts++;
			}

			if (!modal || !modalTitle || modalTitle.textContent !== filename) {
				console.log('Could not find modal with matching filename');
				return 0;
			}



			const content = modal.querySelector(SELECTORS.MODAL_CONTENT);
			if (!content) {
				console.log('Could not find modal content');
				return 0;
			}

			const text = content.textContent || '';
			console.log(`First 100 chars of content: "${text.substring(0, 100)}"`);
			const tokens = calculateTokens(content.textContent || '');
			console.log(`Project file ${filename} tokens:`, tokens);

			if (tokens > 0) {
				GM_setValue(storageKey, tokens);
			}



			const closeButton = modal.querySelector(SELECTORS.MODAL_CLOSE);
			if (closeButton) {
				closeButton.click();
			}

			console.log("Eeeping.")
			await sleep(200);

			return tokens;
		} catch (error) {
			console.error('Error processing project file:', error);
			return 0;
		}
	}

	async function getContentFileTokens(button) {
		try {
			const fileContainer = button.closest('div[data-testid]');
			if (!fileContainer) {
				console.log('Could not find content file container');
				return 0;
			}

			const filename = fileContainer.getAttribute('data-testid');
			if (!filename) {
				console.log('Could not find content file name');
				return 0;
			}

			console.log('Processing content file:', filename);

			const storageKey = getFileStorageKey(filename, false);
			const stored = GM_getValue(storageKey);
			if (stored !== undefined) {
				//console.log(`Using cached tokens for content file: ${filename}`);
				//return stored;
			}

			console.log(`Calculating tokens for content file: ${filename}`);
			button.click();

			const fileView = await waitForElement(SELECTORS.FILE_VIEW_CONTAINER);
			if (!fileView) {
				console.log('Could not find file view');
				return 0;
			}

			const content = fileView.querySelector(SELECTORS.FILE_CONTENT);
			if (!content) {
				console.log('Could not find file content');
				return 0;
			}
			const text = content.textContent || '';
			console.log(`First 100 chars of content: "${text.substring(0, 100)}"`);
			const tokens = calculateTokens(content.textContent || '');
			console.log(`Content file ${filename} tokens:`, tokens);

			if (tokens > 0) {
				GM_setValue(storageKey, tokens);
			}

			const backButton = fileView.querySelector(SELECTORS.BACK_BUTTON);
			if (backButton) {
				backButton.click();
			}

			return tokens;
		} catch (error) {
			console.error('Error processing content file:', error);
			return 0;
		}
	}
	//#endregion

	//#region UI Components
	function createModelSection(modelName, isActive) {
		const container = document.createElement('div');
		container.style.cssText = `
            margin-bottom: 12px;
            border-bottom: 1px solid #3B3B3B;
            padding-bottom: 8px;
            opacity: ${isActive ? '1' : '0.7'};
            transition: opacity 0.2s;
        `;

		container.style.cssText += `
        	position: relative;
    	`;

		const header = document.createElement('div');
		header.style.cssText = `
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
            color: white;
            font-size: 12px;
        `;

		const arrow = document.createElement('div');
		arrow.innerHTML = '▼';
		arrow.style.cssText = `
            cursor: pointer;
            transition: transform 0.2s;
            font-size: 10px;
        `;

		const title = document.createElement('div');
		title.textContent = modelName;
		title.style.cssText = `flex-grow: 1;`;

		const activeIndicator = document.createElement('div');
		activeIndicator.style.cssText = `
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #3b82f6;
            opacity: ${isActive ? '1' : '0'};
            transition: opacity 0.2s;
        `;

		header.appendChild(arrow);
		header.appendChild(title);
		header.appendChild(activeIndicator);

		const content = document.createElement('div');

		// Remove currentCountDisplay, only keep resetTimeDisplay and progress bar
		const resetTimeDisplay = document.createElement('div');
		resetTimeDisplay.style.cssText = `
			color: #888;
			font-size: 11px;
			margin-bottom: 8px;
		`;
		resetTimeDisplay.textContent = 'Reset in: Not set.';


		const progressContainer = document.createElement('div');
		progressContainer.style.cssText = `
            background: #3B3B3B;
            height: 6px;
            border-radius: 3px;
            overflow: hidden;
        `;

		const progressBar = document.createElement('div');
		progressBar.style.cssText = `
            width: 0%;
            height: 100%;
            background: #3b82f6;
            transition: width 0.3s ease, background-color 0.3s ease;
        `;

		const tooltip = document.createElement('div');
		tooltip.style.cssText = `
			position: absolute;
			bottom: 100%;
			left: 50%;
			transform: translateX(-50%);
			background: rgba(0, 0, 0, 0.9);
			color: white;
			padding: 4px 8px;
			border-radius: 4px;
			font-size: 12px;
			opacity: 0;
			transition: opacity 0.2s;
			pointer-events: none;
			margin-bottom: 4px;
			white-space: nowrap;
			z-index: 10000;
		`;

		// Add hover events to the section container
		container.addEventListener('mouseenter', () => {
			tooltip.style.opacity = '1';
		});
		container.addEventListener('mouseleave', () => {
			tooltip.style.opacity = '0';
		});

		progressContainer.appendChild(progressBar);
		content.appendChild(resetTimeDisplay);
		content.appendChild(progressContainer);
		content.appendChild(tooltip);

		container.appendChild(header);
		container.appendChild(content);

		// Toggle section collapse/expand
		let isCollapsed = false;
		arrow.addEventListener('click', (e) => {
			e.stopPropagation();
			isCollapsed = !isCollapsed;
			content.style.display = isCollapsed ? 'none' : 'block';
			arrow.style.transform = isCollapsed ? 'rotate(-90deg)' : '';
		});

		return {
			container,
			progressBar,
			resetTimeDisplay,
			tooltip,
			setActive: (active) => {
				activeIndicator.style.opacity = active ? '1' : '0';
				container.style.opacity = active ? '1' : '0.7';
			}
		};
	}


	function createProgressBar() {
		const container = document.createElement('div');
		container.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: #2D2D2D;
            border: 1px solid #3B3B3B;
            border-radius: 8px;
            z-index: 9999;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
            cursor: move;
            user-select: none;
        `;

		// Header (always visible)
		const header = document.createElement('div');
		header.style.cssText = `
			display: flex;
			align-items: center;
			padding: 8px 10px;
			color: white;
			font-size: 12px;
			gap: 8px;
		`;

		const arrow = document.createElement('div');
		arrow.innerHTML = '▼';
		arrow.style.cssText = `
			cursor: pointer;
			transition: transform 0.2s;
		`;

		header.appendChild(arrow);
		header.appendChild(document.createTextNode('Claude Token Counter'));

		// Last message counter (always visible)
		const lastMessageCounter = document.createElement('div');
		lastMessageCounter.id = 'current-token-count';
		lastMessageCounter.style.cssText = `
			color: white;
			font-size: 12px;
			padding: 0 10px;
			margin-bottom: 8px;
			border-bottom: 1px solid #3B3B3B;
			padding-bottom: 8px;
		`;
		lastMessageCounter.textContent = 'Last message: 0 (weighted) tokens';

		// Content container (collapsible)
		const content = document.createElement('div');
		content.style.cssText = `
			padding: 0 10px 10px 10px;
			width: 250px;
		`;

		// Create sections for each model
		MODELS.forEach(model => {
			const isActive = model === currentModel;
			const section = createModelSection(model, isActive);
			modelSections[model] = section;
			content.appendChild(section.container);
		});

		container.appendChild(header);
		container.appendChild(lastMessageCounter);
		container.appendChild(content);
		document.body.appendChild(container);

		// Toggle collapse/expand
		let isCollapsed = false;
		arrow.addEventListener('click', (e) => {
			e.stopPropagation();
			isCollapsed = !isCollapsed;
			content.style.display = isCollapsed ? 'none' : 'block';
			arrow.style.transform = isCollapsed ? 'rotate(-90deg)' : '';
		});

		// Dragging functionality
		let isDragging = false;
		let currentX;
		let currentY;
		let initialX;
		let initialY;

		header.addEventListener('mousedown', (e) => {
			if (e.target === arrow) return;
			isDragging = true;
			initialX = e.clientX - container.offsetLeft;
			initialY = e.clientY - container.offsetTop;
			header.style.cursor = 'grabbing';
		});

		document.addEventListener('mousemove', (e) => {
			if (!isDragging) return;
			e.preventDefault();
			currentX = e.clientX - initialX;
			currentY = e.clientY - initialY;
			const maxX = window.innerWidth - container.offsetWidth;
			const maxY = window.innerHeight - container.offsetHeight;
			currentX = Math.min(Math.max(0, currentX), maxX);
			currentY = Math.min(Math.max(0, currentY), maxY);
			container.style.left = `${currentX}px`;
			container.style.top = `${currentY}px`;
			container.style.right = 'auto';
			container.style.bottom = 'auto';
		});

		document.addEventListener('mouseup', () => {
			isDragging = false;
			header.style.cursor = 'move';
		});
	}

	function updateProgressBar(currentTotal, lastCount) {
		// Update each model section
		console.log("Updating progress bar...")

		const lastMessageCounter = document.getElementById('current-token-count');
		if (lastMessageCounter) {
			lastMessageCounter.textContent = `Last message: ${lastCount.toLocaleString()} (weighted) tokens`;
		}

		// Update each model section
		MODELS.forEach(modelName => {
			const section = modelSections[modelName];
			if (!section) return;

			const isActiveModel = modelName === currentModel;
			section.setActive(isActiveModel);

			// Get stored data for this model
			const modelStorageKey = `${STORAGE_KEY}_${modelName.replace(/\s+/g, '_')}`;
			console.log(`Checking ${modelStorageKey}...`)
			const stored = GM_getValue(modelStorageKey);

			if (stored) {
				const modelTotal = stored.total;
				const maxTokens = MODEL_TOKENS[modelName] || MODEL_TOKENS.default;
				const percentage = (modelTotal / maxTokens) * 100;

				console.log(`Model ${modelName}: ${modelTotal} tokens, ${percentage.toFixed(1)}%`);

				section.progressBar.style.width = `${Math.min(percentage, 100)}%`;
				section.progressBar.style.background = modelTotal >= maxTokens * WARNING_THRESHOLD ? '#ef4444' : '#3b82f6';

				section.tooltip.textContent = `${modelTotal.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${percentage.toFixed(1)}%)`;

				const resetTime = new Date(stored.resetTimestamp);
				section.resetTimeDisplay.textContent = formatTimeRemaining(resetTime);
			} else {
				console.log(`No stored data for model ${modelName}`);
				section.progressBar.style.width = '0%';
				section.tooltip.textContent = `0 / ${MODEL_TOKENS[modelName].toLocaleString()} tokens (0.0%)`;
				section.resetTimeDisplay.textContent = 'Reset in: Not set';
			}
		});
	}
	//#endregion

	//#region Token Counting Logic
	async function getOutputMessage(maxWaitSeconds = 60) {
		console.log("Waiting for AI response...");
		const startTime = Date.now();
		let consecutiveSuccesses = 0;

		// Wait for complete set of messages
		while (Date.now() - startTime < maxWaitSeconds * 1000) {
			const messages = document.querySelectorAll(SELECTORS.AI_MESSAGE);
			const userMessages = document.querySelectorAll(SELECTORS.USER_MESSAGE);

			if (messages.length >= userMessages.length) {
				// Check if all messages have explicitly finished streaming
				let allFinished = true;
				messages.forEach(msg => {
					const parent = msg.closest('[data-is-streaming]');
					if (!parent || parent.getAttribute('data-is-streaming') !== 'false') {
						allFinished = false;
					}
				});

				if (allFinished) {
					consecutiveSuccesses++;
					console.log(`All messages marked complete, success ${consecutiveSuccesses}/3`);
					if (consecutiveSuccesses >= 3) {
						console.log("Three consecutive successes, returning last response");
						return messages[messages.length - 1];
					}
				} else {
					if (consecutiveSuccesses > 0) {
						console.log(`Reset success counter from ${consecutiveSuccesses} to 0`);
					}
					consecutiveSuccesses = 0;
				}
			}
			await sleep(100);
		}

		console.log("No complete response received within timeout");
		return null;
	}

	async function countTokens() {
		const userMessages = document.querySelectorAll(SELECTORS.USER_MESSAGE);
		const aiMessages = document.querySelectorAll(SELECTORS.AI_MESSAGE);

		console.log('Found user messages:', userMessages);
		console.log('Found AI messages:', aiMessages);

		let currentCount = 0;
		let AI_output = null;

		// Check if we have a complete set of messages
		if (aiMessages.length >= userMessages.length &&
			!aiMessages[aiMessages.length - 1].querySelector('[data-is-streaming="true"]')) {
			console.log("Found complete set of messages, last AI message is complete");
			AI_output = aiMessages[aiMessages.length - 1];
		}

		// Count user messages
		userMessages.forEach((msg, index) => {
			const text = msg.textContent || '';
			const tokens = calculateTokens(text);
			console.log(`User message ${index}:`, msg);
			console.log(`Text: "${text}"`);
			console.log(`Tokens: ${tokens}`);
			currentCount += tokens;
		});

		// Count all AI messages except the final output (if already present)
		aiMessages.forEach((msg, index) => {
			// Skip if this is the final output we're saving for later
			if (msg === AI_output) {
				console.log(`Skipping AI message ${index} - will process later as final output`);
				return;
			}

			const isStreaming = msg.querySelector('[data-is-streaming="true"]');
			if (!isStreaming) {
				const text = msg.textContent || '';
				const tokens = calculateTokens(text); // No multiplication for intermediate responses
				console.log(`AI message ${index}:`, msg);
				console.log(`Text: "${text}"`);
				console.log(`Tokens: ${tokens}`);
				currentCount += tokens;
			} else {
				console.log(`Skipping AI message ${index} - still streaming`);
			}
		});


		// Handle project files from sidebar first
		const projectFiles = new Set(); // Keep track of project files we've processed

		if (await ensureSidebarLoaded()) {
			const projectContainer = document.querySelector(SELECTORS.PROJECT_FILES_CONTAINER);
			const projectFileButtons = projectContainer?.querySelectorAll(SELECTORS.PROJECT_FILES) || [];
			console.log('Found project files in sidebar:', projectFileButtons);

			for (const button of projectFileButtons) {
				projectFiles.add(button);
				const tokens = await getProjectFileTokens(button);
				currentCount += tokens;
			}
		}

		// Now handle all file thumbnails that aren't in the project files set
		const allFileButtons = document.querySelectorAll(SELECTORS.FILE_BUTTONS);
		console.log('Found all file buttons:', allFileButtons);

		for (const button of allFileButtons) {
			if (!projectFiles.has(button)) { // Skip if it's a project file
				console.log("Found non-project file button", button)
				const tokens = await getContentFileTokens(button);
				currentCount += tokens;
			}
		}

		// Ensure sidebar is closed before waiting...
		console.log("Closing sidebar...")
		const sidebar = document.querySelector(SELECTORS.SIDEBAR_CONTENT);
		if (sidebar) {
			const style = window.getComputedStyle(sidebar);
			// If sidebar is visible (not transformed away)
			if (!style.transform.includes('translateX(100%)')) {
				const closeButton = document.querySelector(SELECTORS.SIDEBAR_BUTTON);
				if (closeButton && closeButton.offsetParent !== null) { // Check if button is visible
					closeButton.click();
				}
			}
		}


		if (!AI_output) {
			console.log("No complete AI output found, waiting...");
			AI_output = await getOutputMessage();
		}

		// Process the AI output if we have it (with 5x multiplication)
		if (AI_output) {
			const text = AI_output.textContent || '';
			const tokens = calculateTokens(text) * OUTPUT_TOKEN_MULTIPLIER; // Only multiply the final response by 5
			console.log("Processing final AI output:");
			console.log(`Text: "${text}"`);
			console.log(`Tokens: ${tokens}`);
			currentCount += tokens;
		}


		const { total, isInitialized } = initializeOrLoadStorage();
		console.log(`Loaded total: ${total}`)
		totalTokenCount = isInitialized ? total + currentCount : currentCount;
		currentTokenCount = currentCount;

		saveToStorage(totalTokenCount);

		const stored = GM_getValue(getStorageKey());
		const resetTime = new Date(stored.resetTimestamp);

		console.log(`Current conversation tokens: ${currentCount}`);
		console.log(`Total accumulated tokens: ${totalTokenCount}`);
		console.log(`Next reset at: ${resetTime.toLocaleTimeString()}`);

		updateProgressBar(totalTokenCount, currentCount);


	}
	//#endregion

	//#region Event Handlers
	function pollForModelChanges() {
		setInterval(() => {
			const newModel = getCurrentModel();
			if (newModel !== currentModel) {
				console.log(`Model changed from ${currentModel} to ${newModel}`);
				currentModel = newModel;
				currentTokenCount = 0;
				const { total } = initializeOrLoadStorage();
				totalTokenCount = total;
				updateProgressBar(totalTokenCount, 0);
			}
		}, POLL_INTERVAL_MS);
	}


	function setupEvents() {
		console.log("Setting up tracking...")
		document.addEventListener('click', async (e) => {
			const regenerateButton = e.target.closest(`button:has(path[d="${SELECTORS.REGENERATE_BUTTON_PATH}"])`);
			const saveButton = e.target.closest(SELECTORS.SAVE_BUTTON);
			const sendButton = e.target.closest('button[aria-label="Send Message"]');
			if (regenerateButton || saveButton || sendButton) {
				console.log('Clicked:', e.target);
				console.log('Event details:', e);
				const delay = getConversationId() ? DELAY_MS : 5000;
				console.log(`Waiting ${delay}ms before counting tokens`);
				await sleep(delay);
				await countTokens();
				return;
			}
		});

		document.addEventListener('keydown', async (e) => {
			const mainInput = e.target.closest(SELECTORS.MAIN_INPUT);
			const editArea = e.target.closest(SELECTORS.EDIT_TEXTAREA);
			if ((mainInput || editArea) && e.key === 'Enter' && !e.shiftKey) {
				console.log('Enter pressed in:', e.target);
				console.log('Event details:', e);
				const delay = getConversationId() ? DELAY_MS : 5000;
				console.log(`Waiting ${delay}ms before counting tokens`);
				await sleep(delay);
				await countTokens();
				return;
			}
		});
	}
	//#endregion


	function initialize() {
		console.log('Initializing Chat Token Counter...');
		const { total } = initializeOrLoadStorage();
		totalTokenCount = total;
		currentTokenCount = 0;
		setupEvents();
		createProgressBar();
		updateProgressBar(totalTokenCount, currentTokenCount);
		pollForModelChanges();
		console.log('Initialization complete. Ready to track tokens.');
	}

	initialize();
})();