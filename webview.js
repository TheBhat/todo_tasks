const vscode = acquireVsCodeApi();

let currentParsedLines = [];
let activeLineIndex = null;
let activeCaretOffset = null;

// Multi-line selection state
let selectionStartLine = null;
let activeSelectionEndLine = null;
let isSelectingBlocks = false;
let isDragging = false;
let focusedLineInitialText = null;
let isReRendering = false;
let isLineDirty = false;
let hadBrowserUndoHistory = false;
let isClickingCheckboxOfActiveLine = false;
let clickingCheckboxText = null;

// Parse Markdown into structural elements and extract metadata comments
function parseMarkdown(text) {
  const lines = text.split('\n');
  return lines.map((lineText, index) => {
    let match;
    let created = null;
    let updated = null;
    
    // Extract metadata comment first (c: Created, u: Updated)
    const metaRegex = /\s*<!--\s*c:\s*([\d- :]+),\s*u:\s*([\d- :]+)\s*-->$/;
    const metaMatch = lineText.match(metaRegex);
    let cleanLine = lineText;
    if (metaMatch) {
      created = metaMatch[1];
      updated = metaMatch[2];
      cleanLine = lineText.replace(metaRegex, '');
    }

    // Checkbox checklist: e.g. "  - [ ] Task text"
    if ((match = cleanLine.match(/^(\s*)([-*])\s+\[([\s/?x])\]\s*(.*)$/))) {
      const spaces = match[1].length;
      const bullet = match[2];
      const stateChar = match[3];
      const content = match[4];
      let state = 'pending';
      if (stateChar === '?') state = 'doubt';
      else if (stateChar === '/') state = 'in-progress';
      else if (stateChar === 'x') state = 'completed';
      return { type: 'checkbox', lineIndex: index, indent: spaces, bullet, state, content, created, updated, raw: lineText };
    } 
    // Normal bullet: e.g. "  - Bullet text"
    else if ((match = cleanLine.match(/^(\s*)([-*])\s+(.*)$/))) {
      const spaces = match[1].length;
      const bullet = match[2];
      const content = match[3];
      return { type: 'bullet', lineIndex: index, indent: spaces, bullet, content, created, updated, raw: lineText };
    } 
    // Header: e.g. "## Header text"
    else if ((match = cleanLine.match(/^(#+)\s+(.*)$/))) {
      const level = match[1].length;
      const content = match[2];
      return { type: 'header', lineIndex: index, level, content, raw: lineText };
    } 
    // General text/spacing
    else {
      const matchPlain = cleanLine.match(/^(\s*)(.*)$/);
      const spaces = matchPlain ? matchPlain[1].length : 0;
      const content = matchPlain ? matchPlain[2] : cleanLine;
      return { type: 'text', lineIndex: index, indent: spaces, content, created, updated, raw: lineText };
    }
  });
}

function serializeParsedLinesToMarkdown(parsedLines) {
  return parsedLines.map(item => {
    let baseText = '';
    const indentStr = ' '.repeat(item.indent || 0);
    const bulletChar = item.bullet || '-';
    
    switch (item.type) {
      case 'checkbox':
        let stateChar = ' ';
        if (item.state === 'doubt') stateChar = '?';
        else if (item.state === 'in-progress') stateChar = '/';
        else if (item.state === 'completed') stateChar = 'x';
        baseText = `${indentStr}${bulletChar} [${stateChar}] ${item.content}`;
        break;
      case 'bullet':
        baseText = `${indentStr}${bulletChar} ${item.content}`;
        break;
      case 'header':
        baseText = `${'#'.repeat(item.level)} ${item.content}`;
        break;
      case 'text':
      default:
        baseText = `${indentStr}${item.content}`;
        break;
    }
    
    if (item.created && item.updated && !baseText.trim().startsWith('#') && baseText.trim() !== '') {
      return `${baseText} <!-- c: ${item.created}, u: ${item.updated} -->`;
    }
    return baseText;
  }).join('\n');
}

function normalizeText(text) {
  if (!text) return '';
  let clean = text.replace(/\u00a0/g, ' '); // Replace non-breaking spaces
  if (clean === '\n' || clean.trim() === '') {
    return '';
  }
  return clean;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Convert timestamp YYYY-MM-DD HH:mm to user-friendly "Today HH:mm" or "Month DD HH:mm"
function formatFriendlyTime(ts) {
  if (!ts) return '';
  try {
    const parts = ts.split(' ');
    const dateParts = parts[0].split('-');
    const timeParts = parts[1].split(':');
    
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    
    if (parts[0] === todayStr) {
      return `Today ${timeParts[0]}:${timeParts[1]}`;
    }
    
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[parseInt(dateParts[1]) - 1];
    return `${month} ${parseInt(dateParts[2])} ${timeParts[0]}:${timeParts[1]}`;
  } catch (e) {
    return ts;
  }
}

// Render structural representation to HTML
function renderHtml(parsedLines) {
  if (parsedLines.length === 0 || (parsedLines.length === 1 && parsedLines[0].raw === '')) {
    return `<div class="empty-state">No tasks. Click anywhere to create your first task.</div>`;
  }

  return parsedLines.map(item => {
    const indentStyles = item.indent ? `style="padding-left: ${item.indent * 12}px;"` : '';
    const metaHtml = item.updated ? `
      <span class="row-meta" data-tooltip="Created: ${item.created}\nUpdated: ${item.updated}" user-select="none">
        ${formatFriendlyTime(item.updated)}
      </span>` : '';
    
    switch (item.type) {
      case 'checkbox':
        return `
          <div class="row checkbox-row state-${item.state}" data-line="${item.lineIndex}" ${indentStyles}>
            <div class="checkbox state-${item.state}"></div>
            <span class="task-text" contenteditable="true" data-line="${item.lineIndex}">${escapeHtml(item.content)}</span>
            ${metaHtml}
            <button class="delete-btn" title="Delete Task" data-line="${item.lineIndex}">&times;</button>
          </div>`;
      case 'bullet':
        return `
          <div class="row bullet-row" data-line="${item.lineIndex}" ${indentStyles}>
            <div class="bullet-dot">&bull;</div>
            <span class="task-text" contenteditable="true" data-line="${item.lineIndex}">${escapeHtml(item.content)}</span>
            ${metaHtml}
            <button class="delete-btn" title="Delete Task" data-line="${item.lineIndex}">&times;</button>
          </div>`;
      case 'header':
        return `
          <div class="row header-row h${item.level}-row" data-line="${item.lineIndex}">
            <span class="task-text header h${item.level}" contenteditable="true" data-line="${item.lineIndex}">${escapeHtml(item.content)}</span>
            <button class="delete-btn" title="Delete Task" data-line="${item.lineIndex}">&times;</button>
          </div>`;
      case 'text':
      default:
        // Render empty lines as editable placeholders
        const contentStr = item.content === '' ? '&nbsp;' : escapeHtml(item.content);
        return `
          <div class="row text-row" data-line="${item.lineIndex}" ${indentStyles}>
            <span class="task-text" contenteditable="true" data-line="${item.lineIndex}">${contentStr}</span>
            ${metaHtml}
            <button class="delete-btn" title="Delete Task" data-line="${item.lineIndex}">&times;</button>
          </div>`;
    }
  }).join('');
}

// Caret utilities to track cursor positioning
function getCaretCharacterOffsetWithin(element) {
  let caretOffset = 0;
  const doc = element.ownerDocument || element.document;
  const win = doc.defaultView || doc.parentWindow;
  const sel = win.getSelection();
  if (sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    const preCaretRange = range.cloneRange();
    preCaretRange.selectNodeContents(element);
    preCaretRange.setEnd(range.endContainer, range.endOffset);
    caretOffset = preCaretRange.toString().length;
  }
  return caretOffset;
}

function setCurrentCursorPosition(element, offset) {
  if (offset < 0) return;
  const range = document.createRange();
  const sel = window.getSelection();
  
  let textNode = null;
  if (element.childNodes.length > 0) {
    for (let i = 0; i < element.childNodes.length; i++) {
      if (element.childNodes[i].nodeType === Node.TEXT_NODE) {
        textNode = element.childNodes[i];
        break;
      }
    }
    if (!textNode && element.firstChild) {
      textNode = element.firstChild;
    }
  }
  
  if (textNode) {
    const length = textNode.textContent.length;
    const realOffset = Math.min(offset, length);
    range.setStart(textNode, realOffset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    element.focus();
  }
}

// Reindex line indices in local state array
function reindexLines() {
  currentParsedLines.forEach((item, index) => {
    item.lineIndex = index;
  });
}

// Render local DOM content
function renderLocally() {
  isReRendering = true;
  const appEl = document.getElementById('tasks-container');
  appEl.innerHTML = renderHtml(currentParsedLines);
  isReRendering = false;
}

// Focus a specific line and set caret position
function focusLine(lineIndex, caretOffset = 0) {
  const el = document.querySelector(`.task-text[data-line="${lineIndex}"]`);
  if (el) {
    el.focus();
    setCurrentCursorPosition(el, caretOffset);
  }
}

// Clear multi-line row selections
function clearBlockSelection() {
  isSelectingBlocks = false;
  selectionStartLine = null;
  activeSelectionEndLine = null;
  document.querySelectorAll('.row.selected-row').forEach(el => {
    el.classList.remove('selected-row');
  });
}

// Highlight a range of rows visually
function highlightRange(start, end) {
  document.querySelectorAll('.row.selected-row').forEach(el => {
    el.classList.remove('selected-row');
  });
  
  const min = Math.min(start, end);
  const max = Math.max(start, end);
  for (let i = min; i <= max; i++) {
    const rowEl = document.querySelector(`.row[data-line="${i}"]`);
    if (rowEl) {
      rowEl.classList.add('selected-row');
    }
  }
}

// Get timestamp in local format
function getTimestampLocal() {
  const now = new Date();
  const YYYY = now.getFullYear();
  const MM = String(now.getMonth() + 1).padStart(2, '0');
  const DD = String(now.getDate()).padStart(2, '0');
  const HH = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${YYYY}-${MM}-${DD} ${HH}:${mm}`;
}

// Toggle logic: regular click cycles, modifier click toggles doubt
function handleToggle(lineIndex, action) {
  const item = currentParsedLines[lineIndex];
  if (!item || item.type !== 'checkbox') return;
  
  let newState = 'pending';
  
  if (action === 'toggle-doubt') {
    if (item.state === 'doubt') {
      newState = 'pending';
    } else {
      newState = 'doubt';
    }
  } else {
    if (item.state === 'pending') {
      newState = 'in-progress';
    } else if (item.state === 'doubt') {
      newState = 'in-progress';
    } else if (item.state === 'in-progress') {
      newState = 'completed';
    } else if (item.state === 'completed') {
      newState = 'pending';
    }
  }
  
  let textToSend = null;
  if (isClickingCheckboxOfActiveLine) {
    textToSend = clickingCheckboxText;
    item.content = clickingCheckboxText;
    
    isClickingCheckboxOfActiveLine = false;
    clickingCheckboxText = null;
    focusedLineInitialText = null;
    isLineDirty = false;
  }
  
  // Optimistic UI Update: update state and timestamp locally, then re-render instantly
  item.state = newState;
  item.updated = getTimestampLocal();
  renderLocally();
  
  vscode.postMessage({
    type: 'toggle',
    lineIndex,
    newState,
    text: textToSend
  });
}

// Event Listeners
document.addEventListener('mousedown', (e) => {
  isClickingCheckboxOfActiveLine = false;
  clickingCheckboxText = null;

  if (e.target.classList.contains('checkbox')) {
    const row = e.target.closest('.row');
    const lineIndex = row ? parseInt(row.dataset.line) : null;
    const activeEl = document.activeElement;
    if (activeEl && activeEl.classList.contains('task-text') && parseInt(activeEl.dataset.line) === lineIndex) {
      const newText = normalizeText(activeEl.innerText);
      if (focusedLineInitialText !== null && newText !== focusedLineInitialText) {
        isClickingCheckboxOfActiveLine = true;
        clickingCheckboxText = newText;
      }
    }
    return;
  }

  if (e.target.classList.contains('raw-btn')) {
    return;
  }

  const row = e.target.closest('.row');
  if (row) {
    isDragging = true;
    selectionStartLine = parseInt(row.dataset.line);
    activeSelectionEndLine = selectionStartLine;
  } else {
    isDragging = false;
    selectionStartLine = null;
    activeSelectionEndLine = null;
  }
  
  // Clear selection if clicking normally on non-modifier click
  const hasModifier = e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
  if (!hasModifier) {
    clearBlockSelection();
    // Re-initialize selection start/end for starting a new drag or shift-arrow selection
    if (row) {
      selectionStartLine = parseInt(row.dataset.line);
      activeSelectionEndLine = selectionStartLine;
    }
  }
});

document.addEventListener('mouseover', (e) => {
  if (isDragging && selectionStartLine !== null) {
    const row = e.target.closest('.row');
    if (row) {
      const currentLine = parseInt(row.dataset.line);
      if (currentLine !== selectionStartLine) {
        isSelectingBlocks = true;
        activeSelectionEndLine = currentLine;
        // Wipe regular text highlights to avoid visual clutter
        window.getSelection().removeAllRanges();
        highlightRange(selectionStartLine, currentLine);
      }
    }
  }
});

document.addEventListener('mouseup', () => {
  isDragging = false;
});

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('raw-btn')) {
    vscode.postMessage({ type: 'openRaw' });
  } else if (e.target.classList.contains('header-btn')) {
    let targetIndex = activeLineIndex;
    if (targetIndex === null || targetIndex < 0 || targetIndex >= currentParsedLines.length) {
      targetIndex = currentParsedLines.length > 0 ? currentParsedLines.length - 1 : 0;
    }
    
    const existingItem = currentParsedLines[targetIndex];
    const headerText = (existingItem && existingItem.content && existingItem.content.trim() !== '') ? existingItem.content : 'Header';
    
    if (currentParsedLines.length === 0) {
      currentParsedLines.push({
        type: 'header',
        lineIndex: 0,
        level: 1,
        content: headerText,
        raw: `# ${headerText}`
      });
    } else {
      currentParsedLines[targetIndex] = {
        type: 'header',
        lineIndex: targetIndex,
        level: 1,
        content: headerText,
        raw: `# ${headerText}`
      };
    }
    
    reindexLines();
    renderLocally();
    focusLine(targetIndex, headerText.length);
    
    vscode.postMessage({
      type: 'makeHeader',
      lineIndex: targetIndex,
      text: headerText
    });
  } else if (e.target.classList.contains('checkbox')) {
    const row = e.target.closest('.row');
    const lineIndex = parseInt(row.dataset.line);
    
    const hasModifier = e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
    handleToggle(lineIndex, hasModifier ? 'toggle-doubt' : 'cycle-regular');
  } else if (e.target.classList.contains('delete-btn')) {
    const lineIndex = parseInt(e.target.dataset.line);
    
    // Delete locally first
    currentParsedLines.splice(lineIndex, 1);
    reindexLines();
    renderLocally();
    
    // Move focus to previous line or first line
    const targetLine = lineIndex > 0 ? lineIndex - 1 : 0;
    const prevItem = currentParsedLines[targetLine];
    const caretPos = prevItem ? prevItem.content.length : 0;
    focusLine(targetLine, caretPos);
    
    vscode.postMessage({
      type: 'deleteLine',
      lineIndex
    });
  } else {
    // If we click anywhere on the empty state or tasks container when there are no lines
    const isEmpty = currentParsedLines.length === 0 || (currentParsedLines.length === 1 && currentParsedLines[0].raw === '');
    if (isEmpty && (e.target.closest('#app') || e.target.closest('#tasks-container') || e.target.classList.contains('empty-state'))) {
      currentParsedLines = [{
        type: 'checkbox',
        lineIndex: 0,
        indent: 0,
        bullet: '-',
        state: 'pending',
        content: '',
        created: getTimestampLocal(),
        updated: getTimestampLocal(),
        raw: ''
      }];
      renderLocally();
      focusLine(0, 0);
      
      vscode.postMessage({
        type: 'newLine',
        lineIndex: 0,
        text: ''
      });
    }
  }
});

document.addEventListener('focusin', (e) => {
  if (e.target.classList.contains('task-text')) {
    activeLineIndex = parseInt(e.target.dataset.line);
    focusedLineInitialText = normalizeText(e.target.innerText);
    isLineDirty = false;
    hadBrowserUndoHistory = false;
  }
});

document.addEventListener('input', (e) => {
  if (e.target.classList.contains('task-text')) {
    const previousDirty = isLineDirty;
    const currentText = normalizeText(e.target.innerText);
    isLineDirty = currentText !== focusedLineInitialText;
    // Track when browser undo has brought text back to initial state
    if (previousDirty && !isLineDirty) {
      hadBrowserUndoHistory = true;
    }
  }
});

document.addEventListener('focusout', (e) => {
  if (!e.target.isConnected || isReRendering) return;
  if (e.target.classList.contains('task-text')) {
    if (isClickingCheckboxOfActiveLine) {
      // The edit message will be bundled with the toggle message
      focusedLineInitialText = null;
      isLineDirty = false;
      hadBrowserUndoHistory = false;
      return;
    }

    focusedLineInitialText = null;
    isLineDirty = false;
    hadBrowserUndoHistory = false;
    const lineIndex = parseInt(e.target.dataset.line);
    const newText = normalizeText(e.target.innerText);

    const item = currentParsedLines[lineIndex];
    if (item && item.content !== newText) {
      item.content = newText;
      item.updated = getTimestampLocal();

      // Directly update the metadata element in the DOM to avoid re-rendering
      // and breaking click target transitions (e.g. clicking the checkbox right after typing)
      const rowEl = document.querySelector(`.row[data-line="${lineIndex}"]`);
      if (rowEl) {
        let metaEl = rowEl.querySelector('.row-meta');
        if (!metaEl) {
          metaEl = document.createElement('span');
          metaEl.className = 'row-meta';
          metaEl.setAttribute('user-select', 'none');
          rowEl.appendChild(metaEl);
        }
        metaEl.setAttribute('data-tooltip', `Created: ${item.created}\nUpdated: ${item.updated}`);
        metaEl.innerText = formatFriendlyTime(item.updated);
      }

      vscode.postMessage({
        type: 'editLine',
        lineIndex,
        text: newText
      });
    }
  }
});

document.addEventListener('keydown', (e) => {
  // Handle Undo (Cmd+Z / Ctrl+Z), Redo (Cmd+Shift+Z / Ctrl+Y / Cmd+Y), and Save (Cmd+S / Ctrl+S)
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const isUndo = (isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey;
  const isRedo = (isMac ? e.metaKey && e.shiftKey && e.key.toLowerCase() === 'z' : (e.ctrlKey && e.key.toLowerCase() === 'y') || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'z'));
  const isSave = (isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 's';

  if (isSave) {
    const activeEl = document.activeElement;
    if (activeEl && activeEl.classList.contains('task-text')) {
      const lineIndex = parseInt(activeEl.dataset.line);
      const newText = normalizeText(activeEl.innerText);
      const item = currentParsedLines[lineIndex];
      if (item && item.content !== newText) {
        item.content = newText;
        item.updated = getTimestampLocal();
        focusedLineInitialText = newText;
        isLineDirty = false;
        hadBrowserUndoHistory = false;
        
        // Directly update the metadata element in the DOM
        const rowEl = document.querySelector(`.row[data-line="${lineIndex}"]`);
        if (rowEl) {
          let metaEl = rowEl.querySelector('.row-meta');
          if (!metaEl) {
            metaEl = document.createElement('span');
            metaEl.className = 'row-meta';
            metaEl.setAttribute('user-select', 'none');
            rowEl.appendChild(metaEl);
          }
          metaEl.setAttribute('data-tooltip', `Created: ${item.created}\nUpdated: ${item.updated}`);
          metaEl.innerText = formatFriendlyTime(item.updated);
        }

        vscode.postMessage({
          type: 'editLine',
          lineIndex,
          text: newText
        });
      }
    }
    // Do NOT call e.preventDefault(), let Cmd+S propagate to VS Code so it saves the file!
  }

  if (isUndo) {
    e.preventDefault();
    const activeEl = document.activeElement;
    const isEditingText = activeEl && activeEl.classList.contains('task-text');
    if (isEditingText && isLineDirty) {
      document.execCommand('undo');
    } else {
      vscode.postMessage({ type: 'undo' });
    }
    return;
  }

  if (isRedo) {
    e.preventDefault();
    const activeEl = document.activeElement;
    const isEditingText = activeEl && activeEl.classList.contains('task-text');
    if (isEditingText && (isLineDirty || hadBrowserUndoHistory)) {
      document.execCommand('redo');
    } else {
      vscode.postMessage({ type: 'redo' });
    }
    return;
  }

  // Clear block selection if we press any key that is not allowed while multiple lines are selected.
  // Allowed keys are modifiers/helpers, arrows (handled lower down), Backspace/Delete, and Escape.
  const selectedRows = document.querySelectorAll('.row.selected-row');
  if (selectedRows.length > 0) {
    const allowedKeys = [
      'Backspace', 'Delete', 'Escape', 
      'Shift', 'Control', 'Alt', 'Meta',
      'ArrowUp', 'ArrowDown'
    ];
    if (!allowedKeys.includes(e.key)) {
      clearBlockSelection();
    }
  }

  // 1. Intercept Backspace/Delete/Escape if multiple rows are selected
  if (selectedRows.length > 0) {
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      
      const indicesToDelete = Array.from(selectedRows)
        .map(row => parseInt(row.dataset.line))
        .sort((a, b) => b - a); // Sort descending to splice without shifting targets
      
      const minIndex = Math.min(...indicesToDelete);
      const focusIndex = minIndex > 0 ? minIndex - 1 : 0;
      
      // Delete locally
      indicesToDelete.forEach(idx => {
        currentParsedLines.splice(idx, 1);
      });
      
      reindexLines();
      renderLocally();
      
      const prevItem = currentParsedLines[focusIndex];
      const caretPos = prevItem ? prevItem.content.length : 0;
      focusLine(focusIndex, caretPos);
      
      // Send single batch deletion command to VS Code
      vscode.postMessage({
        type: 'deleteLines',
        lineIndices: indicesToDelete
      });
      
      clearBlockSelection();
      return;
    } else if (e.key === 'Escape') {
      e.preventDefault();
      clearBlockSelection();
      return;
    }
  }

  // 2. Standard row outliner editing hotkeys
  if (e.target.classList.contains('task-text')) {
    const lineIndex = parseInt(e.target.dataset.line);
    
    // Shift + Arrow selection support
    if (e.shiftKey && e.key === 'ArrowUp') {
      e.preventDefault();
      
      if (!isSelectingBlocks) {
        if (selectionStartLine === null) {
          selectionStartLine = lineIndex;
        }
        isSelectingBlocks = true;
      }
      
      const targetIndex = activeSelectionEndLine !== null ? activeSelectionEndLine - 1 : lineIndex - 1;
      const prevRowText = document.querySelector(`.task-text[data-line="${targetIndex}"]`);
      if (prevRowText) {
        activeSelectionEndLine = targetIndex;
        window.getSelection().removeAllRanges();
        highlightRange(selectionStartLine, targetIndex);
        
        prevRowText.focus();
        setCurrentCursorPosition(prevRowText, prevRowText.textContent.length);
      }
      return;
    }
    else if (e.shiftKey && e.key === 'ArrowDown') {
      e.preventDefault();
      
      if (!isSelectingBlocks) {
        if (selectionStartLine === null) {
          selectionStartLine = lineIndex;
        }
        isSelectingBlocks = true;
      }
      
      const targetIndex = activeSelectionEndLine !== null ? activeSelectionEndLine + 1 : lineIndex + 1;
      const nextRowText = document.querySelector(`.task-text[data-line="${targetIndex}"]`);
      if (nextRowText) {
        activeSelectionEndLine = targetIndex;
        window.getSelection().removeAllRanges();
        highlightRange(selectionStartLine, targetIndex);
        
        nextRowText.focus();
        setCurrentCursorPosition(nextRowText, nextRowText.textContent.length);
      }
      return;
    }
    
    if (e.key === 'Enter') {
      e.preventDefault();
      
      const activeEl = document.activeElement;
      let newText = activeEl ? activeEl.innerText : '';
      if (newText === '\n') newText = ''; 
      
      const currentItem = currentParsedLines[lineIndex];
      let newIndent = currentItem ? currentItem.indent : 0;
      let newType = currentItem ? currentItem.type : 'checkbox';
      // Headers don't continue — start a fresh checkbox after them
      if (newType === 'header') { newType = 'checkbox'; newIndent = 0; }
      let newBullet = currentItem ? (currentItem.bullet || '-') : '-';
      let newState = 'pending';
      let newContent = '';
      
      // Update local state instantly
      if (currentItem) {
        currentItem.content = newText;
        currentItem.updated = getTimestampLocal();
      }
      
      currentParsedLines.splice(lineIndex + 1, 0, {
        type: newType,
        lineIndex: lineIndex + 1,
        indent: newIndent,
        bullet: newBullet,
        state: newState,
        content: newContent,
        created: getTimestampLocal(),
        updated: getTimestampLocal(),
        raw: ''
      });
      
      reindexLines();
      renderLocally();
      focusLine(lineIndex + 1, 0);
      
      // Send single atomic message
      vscode.postMessage({
        type: 'newLine',
        lineIndex,
        text: newText
      });
    } 
    else if (e.key === 'Tab') {
      e.preventDefault();
      
      const activeEl = document.activeElement;
      let newText = activeEl ? activeEl.innerText : '';
      if (newText === '\n') newText = '';
      
      const direction = e.shiftKey ? 'out' : 'in';
      const item = currentParsedLines[lineIndex];
      if (item) {
        item.content = newText;
        if (direction === 'in') {
          item.indent += 2;
        } else {
          item.indent = Math.max(0, item.indent - 2);
        }
        item.updated = getTimestampLocal();
        
        renderLocally();
        focusLine(lineIndex, getCaretCharacterOffsetWithin(e.target));
      }
      
      vscode.postMessage({
        type: 'indentLine',
        lineIndex,
        text: newText,
        direction
      });
    }
    else if (e.key === 'Backspace') {
      const text = e.target.innerText;
      if (text.length === 0 || text === '\n') {
        e.preventDefault();
        
        const item = currentParsedLines[lineIndex];
        if (item && item.indent && item.indent > 0) {
          // Outdent locally first
          item.indent = Math.max(0, item.indent - 2);
          item.updated = getTimestampLocal();
          renderLocally();
          focusLine(lineIndex, 0);
          
          vscode.postMessage({
            type: 'indentLine',
            lineIndex,
            text: '',
            direction: 'out'
          });
        } else {
          // Delete locally first
          currentParsedLines.splice(lineIndex, 1);
          reindexLines();
          renderLocally();
          
          const targetLine = lineIndex > 0 ? lineIndex - 1 : 0;
          const prevItem = currentParsedLines[targetLine];
          const caretPos = prevItem ? prevItem.content.length : 0;
          focusLine(targetLine, caretPos);
          
          vscode.postMessage({
            type: 'deleteLine',
            lineIndex
          });
        }
      }
    }
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      clearBlockSelection();
      const prevRowText = document.querySelector(`.task-text[data-line="${lineIndex - 1}"]`);
      if (prevRowText) {
        prevRowText.focus();
        setCurrentCursorPosition(prevRowText, prevRowText.textContent.length);
      }
    }
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      clearBlockSelection();
      const nextRowText = document.querySelector(`.task-text[data-line="${lineIndex + 1}"]`);
      if (nextRowText) {
        nextRowText.focus();
        setCurrentCursorPosition(nextRowText, nextRowText.textContent.length);
      }
    }
  }
});

// Sync from Extension to Webview
window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'update') {
    const incomingText = message.text;
    const localText = serializeParsedLinesToMarkdown(currentParsedLines);
    
    // If the update is triggered by our own edits (texts match), ignore it to avoid focus loss and caret jumps
    if (incomingText === localText) {
      return;
    }
    
    const activeEl = document.activeElement;
    let activeLineIndex = null;
    let activeCaretOffset = null;
    let hasUnsavedTextEdits = false;
    let unsavedText = '';
    
    if (activeEl && activeEl.classList.contains('task-text')) {
      activeLineIndex = parseInt(activeEl.dataset.line);
      activeCaretOffset = getCaretCharacterOffsetWithin(activeEl);
      if (focusedLineInitialText !== null && activeEl.innerText !== focusedLineInitialText) {
        hasUnsavedTextEdits = true;
        unsavedText = activeEl.innerText;
      }
    }
    
    currentParsedLines = parseMarkdown(incomingText);
    
    // Preserve local unsaved edits on the active line if we must re-render
    if (hasUnsavedTextEdits && activeLineIndex !== null && currentParsedLines[activeLineIndex]) {
      currentParsedLines[activeLineIndex].content = unsavedText;
    }
    
    renderLocally();
    
    // Focus restoration
    if (activeLineIndex !== null) {
      focusLine(activeLineIndex, activeCaretOffset);
      activeLineIndex = null;
      activeCaretOffset = null;
    }
  }
});

// Post the ready message to tell the extension we are ready to receive the initial document text
vscode.postMessage({ type: 'ready' });
