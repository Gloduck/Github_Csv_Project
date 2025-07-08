// ==UserScript==
// @name         Cookie管理器
// @namespace    cookie_manager
// @version      1.0
// @description  支持Cookie跨机器同步，使用Github仓库作为远程存储（Cookie为敏感信息，不要使用公共仓库，请使用私有仓库）
// @author       Gloduck
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_cookie
// @grant        GM_deleteValue
// @connect      api.github.com
// @require      https://cdn.jsdelivr.net/npm/sweetalert2@11
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // 配置存储键名
    const CONFIG_KEYS = {
        TOKEN: 'GITHUB_TOKEN',
        OWNER: 'GITHUB_OWNER',
        REPO: 'GITHUB_REPO',
        BRANCH: 'GITHUB_BRANCH'
    };

    const DB_FILE = {
        PATH: 'db',
        FILE: 'cookie'
    }

    // 获取当前配置
    async function getConfig() {
        return {
            token: await GM_getValue(CONFIG_KEYS.TOKEN, ''),
            owner: await GM_getValue(CONFIG_KEYS.OWNER, ''),
            repo: await GM_getValue(CONFIG_KEYS.REPO, ''),
            branch: await GM_getValue(CONFIG_KEYS.BRANCH, 'main')
        };
    }

    // 显示配置弹窗
    async function showConfigDialog() {
        const config = await getConfig();

        const {value: formValues} = await Swal.fire({
            title: 'GitHub 仓库设置',
            html: `
                <input id="owner" class="swal2-input" placeholder="仓库所有者" value="${config.owner}">
                <input id="repo" class="swal2-input" placeholder="仓库名称" value="${config.repo}">
                <input id="branch" class="swal2-input" placeholder="分支 (默认main)" value="${config.branch}">
                <input id="token" class="swal2-input" placeholder="GitHub Personal Token" type="password" value="${config.token}">
            `,
            focusConfirm: false,
            preConfirm: () => {
                return {
                    owner: document.getElementById('owner').value,
                    repo: document.getElementById('repo').value,
                    branch: document.getElementById('branch').value || 'main',
                    token: document.getElementById('token').value
                };
            },
            showCancelButton: true
        });

        if (formValues) {
            await GM_setValue(CONFIG_KEYS.OWNER, formValues.owner);
            await GM_setValue(CONFIG_KEYS.REPO, formValues.repo);
            await GM_setValue(CONFIG_KEYS.BRANCH, formValues.branch);
            await GM_setValue(CONFIG_KEYS.TOKEN, formValues.token);
            Swal.fire('保存成功!', '仓库配置已更新', 'success');
        }
    }

    // GitHub API请求封装
    async function githubApiRequest(method, endpoint, data = null) {
        const config = await getConfig();

        if (!config.token || !config.owner || !config.repo) {
            throw new Error('请先配置GitHub仓库信息');
        }

        const url = `https://api.github.com/repos/${config.owner}/${config.repo}${endpoint}`;
        const headers = {
            "Authorization": `Bearer ${config.token}`,
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json"
        };

        const options = {
            method: method,
            headers: headers,
            body: data ? JSON.stringify(data) : null
        };

        try {
            const response = await fetch(url, options);

            // 处理非2xx响应
            if (!response.ok) {
                let errorBody;
                try {
                    errorBody = await response.json();
                } catch (e) {
                    errorBody = {message: `API请求失败: ${response.status} ${response.statusText}`};
                }
                throw {
                    status: response.status,
                    message: errorBody.message || 'API请求失败',
                    response: errorBody
                };
            }

            // 处理204 No Content等空响应
            if (response.status === 204 || response.headers.get('Content-Length') === '0') {
                return null;
            }

            return await response.json();
        } catch (error) {
            if (error.status) {
                // 已处理的API错误
                throw error;
            }
            // 网络错误
            throw {
                status: 0,
                message: '网络请求失败',
                error: error
            };
        }
    }


    // 1. 创建文件
    async function createFile(path, content, message = "Created via Tampermonkey") {
        const encodedContent = btoa(unescape(encodeURIComponent(content)));
        return githubApiRequest('PUT', `/contents/${encodeURIComponent(path)}`, {
            message,
            content: encodedContent,
            branch: (await getConfig()).branch
        });
    }

    // 2. 更新文件
    async function updateFile(path, content, message = "Updated via Tampermonkey") {
        // 先获取文件当前SHA
        const fileInfo = await getFileInfo(path);
        const encodedContent = btoa(unescape(encodeURIComponent(content)));
        return githubApiRequest('PUT', `/contents/${encodeURIComponent(path)}`, {
            message,
            content: encodedContent,
            sha: fileInfo.sha,
            branch: (await getConfig()).branch
        });
    }

    // 3. 删除文件
    async function deleteFile(path, message = "Deleted via Tampermonkey") {
        // 先获取文件当前SHA
        const fileInfo = await getFileInfo(path);

        return githubApiRequest('DELETE', `/contents/${encodeURIComponent(path)}`, {
            message,
            sha: fileInfo.sha,
            branch: (await getConfig()).branch
        });
    }

    // 4. 获取文件信息（不包含内容）
    async function getFileInfo(path) {
        return githubApiRequest('GET', `/contents/${encodeURIComponent(path)}?ref=${(await getConfig()).branch}`);
    }

    // 5. 获取文件内容
    async function getFileContent(path) {
        const fileInfo = await getFileInfo(path);
        if (fileInfo.encoding === 'base64') {
            return decodeURIComponent(escape(atob(fileInfo.content)));
        }
        return fileInfo.content;
    }

    // 6. 获取仓库所有文件列表（递归）
    async function getAllFiles(path = '', files = []) {
        const contents = await githubApiRequest('GET', `/contents/${encodeURIComponent(path)}?ref=${(await getConfig()).branch}`);

        for (const item of contents) {
            if (item.type === 'file') {
                files.push({
                    path: item.path,
                    size: item.size,
                    sha: item.sha
                });
            } else if (item.type === 'dir') {
                await getAllFiles(item.path, files);
            }
        }

        return files;
    }


    class CsvUtils {
        static parseCsvLine(line) {
            const result = [];
            let current = '';
            let inQuotes = false;
            let i = 0;

            while (i < line.length) {
                const char = line[i];

                if (inQuotes) {
                    if (char === '"' && i + 1 < line.length && line[i + 1] === '"') {
                        current += '"';
                        i += 2;
                        continue;
                    } else if (char === '"') {
                        inQuotes = false;
                        i++;
                        continue;
                    } else {
                        current += char;
                        i++;
                    }
                } else {
                    if (char === '"') {
                        inQuotes = true;
                        i++;
                    } else if (char === ',') {
                        result.push(CsvUtils.unescapeField(current));
                        current = '';
                        i++;
                    } else {
                        current += char;
                        i++;
                    }
                }
            }
            result.push(CsvUtils.unescapeField(current));
            return result;
        }

        static unescapeField(field) {
            return field.replace(/\\"/g, '"')
                .replace(/\\,/g, ',');
        }

        static escapeCsvField(field) {
            if (field == null) return '';
            if (typeof field !== 'string') field = String(field);

            if (field.includes(',') || field.includes('"') || field.includes('\n')) {
                return '"' + field.replace(/"/g, '""') + '"';
            }
            return field;
        }

        static compareValue(a, b) {
            const numA = parseFloat(a);
            const numB = parseFloat(b);
            if (!isNaN(numA) && !isNaN(numB)) {
                return numA - numB;
            }
            return a.localeCompare(b, undefined, {numeric: true});
        }
    }


    function csvDataFilter() {
        const _filters = []

        function test(row) {
            return _filters.every(f => f(row));
        }

        function eq(fieldName, value) {
            const strValue = (value === null || value === undefined) ? null : String(value);
            _filters.push(row => {
                const v = row[fieldName];
                if (v === null || v === undefined) {
                    return strValue === null;
                }
                if (strValue === null) {
                    return false;
                }
                return v === strValue;
            });
        }

        function notEq(fieldName, value) {
            const strValue = (value === null || value === undefined) ? null : String(value);
            _filters.push(row => {
                const v = row[fieldName];
                if (v === null || v === undefined) {
                    return strValue !== null;
                }
                if (strValue === null) {
                    return true;
                }
                return v !== strValue;
            });
        }

        function inValues(fieldName, ...values) {
            const set = new Set(values.map(v => v == null ? null : String(v)));
            _filters.push(row => {
                const v = row[fieldName];
                const valueToCheck = (v === undefined) ? null : v;
                return set.has(valueToCheck);
            });
        }

        function notIn(fieldName, ...values) {
            const set = new Set(values.map(v => v == null ? null : String(v)));
            _filters.push(row => {
                const v = row[fieldName];
                const valueToCheck = (v === undefined) ? null : v;
                return !set.has(valueToCheck);
            });
        }

        function like(fieldName, pattern) {
            const regex = new RegExp('^' + pattern
                .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                .replace(/%/g, '.*')
                .replace(/_/g, '.') + '$');

            _filters.push(row => {
                const v = row[fieldName] ?? '';
                return regex.test(v);
            });
        }

        function gt(fieldName, value) {
            _cmpHelper(fieldName, value, cmpResult => cmpResult > 0);
        }

        function ge(fieldName, value) {
            _cmpHelper(fieldName, value, cmpResult => cmpResult >= 0);
        }

        function lt(fieldName, value) {
            _cmpHelper(fieldName, value, cmpResult => cmpResult < 0);
        }

        function le(fieldName, value) {
            _cmpHelper(fieldName, value, cmpResult => cmpResult <= 0);
        }

        function _cmpHelper(fieldName, value, tester) {
            const strValue = (value === null || value === undefined) ? null : String(value);
            _filters.push(row => {
                const v = row[fieldName];
                if (v == null || strValue == null) {
                    return false;
                }
                const cmpResult = CsvUtils.compareValue(v, strValue);
                return tester(cmpResult);
            });
        }

        return {
            test,
            eq,
            notEq,
            inValues,
            notIn,
            like,
            gt,
            ge,
            lt,
            le
        }
    }

    function csvDataFetcher() {
        const handler = {
            shouldHandleData(row) {
                throw new Error("shouldHandleData must be implemented");
            },
            lineOffset() {
                return 0;
            },
            lineLimit() {
                return Number.MAX_VALUE;
            },
            orderField() {
                return null;
            },
            orderDesc() {
                return false;
            },
            selectField() {
                return null;
            }
        }


        function fetch(csvContent) {
            const lines = csvContent.split('\n');
            if (lines.length === 0) {
                throw new Error("csv must contains header");
            }

            const headers = CsvUtils.parseCsvLine(lines[0]);
            const records = [];

            for (let i = 1; i < lines.length; i++) {
                if (!lines[i].trim()) continue;
                const values = CsvUtils.parseCsvLine(lines[i]);
                const row = {};
                headers.forEach((header, index) => {
                    row[header] = values[index] || '';
                });
                if (!handler.shouldHandleData(row)) {
                    continue;
                }
                records.push(row);
            }
            const valueOrderFiled = handler.orderField();
            const valueOrderDesc = handler.orderDesc();
            if (valueOrderFiled != null) {
                records.sort((a, b) => {
                    const v1 = a[valueOrderFiled];
                    const v2 = b[valueOrderFiled];
                    const cmpResult = CsvUtils.compareValue(v1, v2);
                    return valueOrderDesc ? -cmpResult : cmpResult;
                });
            }
            const start = handler.lineOffset();
            const end = start + handler.lineLimit();
            const selectFields = handler.selectField();
            if (selectFields == null) {
                return records.slice(start, end);
            } else {
                return records.slice(start, end).map(row => {
                    const newRow = {};
                    selectFields.forEach(field => {
                        newRow[field] = row[field];
                    });
                    return newRow;
                });
            }
        }

        return {
            fetch,
            handler
        }
    }

    function csvModifyHandler() {
        const handler = {
            appendRows() {
                throw new Error("shouldHandleData must be implemented");
            },

            shouldHandleData(row) {
                throw new Error("shouldHandleData must be implemented");
            },

            handleData(row) {
                throw new Error("handleData must be implemented");
            },
        }

        function execute(csvContent) {
            const lines = csvContent.split('\n');
            if (lines.length === 0) {
                throw new Error("csv must contains header");
            }

            const headers = CsvUtils.parseCsvLine(lines[0]);
            const records = [];
            let affectedCount = 0;

            for (let i = 1; i < lines.length; i++) {
                if (!lines[i].trim()) continue;
                const values = CsvUtils.parseCsvLine(lines[i]);
                const row = {};
                headers.forEach((header, index) => {
                    row[header] = values[index] || '';
                });

                if (handler.shouldHandleData(row)) {
                    const newRow = handler.handleData({...row});
                    if (newRow !== null) {
                        records.push(prepareRecord(headers, newRow));
                    }
                    affectedCount++;
                } else {
                    records.push(values);
                }
            }

            for (const row of handler.appendRows()) {
                records.push(prepareRecord(headers, row));
                affectedCount++;
            }

            const newHeaders = headers.join(',');
            const newCsv = [newHeaders, ...records.map(values =>
                values.map(v => CsvUtils.escapeCsvField(v)).join(',')
            )].join('\n');
            return {
                affectedCount: affectedCount,
                csvContent: newCsv
            };
        }

        function prepareRecord(headers, row) {
            return headers.map(header => row[header] ?? '');
        }

        return {
            handler,
            execute,
        };
    }

    function csvDb(csvPath) {
        async function createIfNotExist(csvFileName, headers) {
            const path = `${csvPath}/${csvFileName}.csv`;
            try {
                await getFileInfo(path);
                return false;
            } catch (error) {
                if (error.status === 404) {
                    try {
                        await createFile(path, headers);
                        return true;
                    } catch (createError) {
                        throw createError;
                    }
                } else {
                    throw error;
                }
            }
        }

        async function create(csvFileName, headers) {
            const path = `${csvPath}/${csvFileName}.csv`;
            const csvContent = headers.join(',') + '\n';
            await createFile(path, csvContent);
        }

        function update(csvFileName) {
            const updateFields = {};
            const path = `${csvPath}/${csvFileName}.csv`;
            const csvHandler = csvModifyHandler();
            const csvFilter = csvDataFilter();
            csvHandler.handler.shouldHandleData = (row) => {
                return csvFilter.test(row);
            };
            csvHandler.handler.handleData = (row) => {
                Object.entries(updateFields).forEach(([field, newVal]) => {
                    row[field] = (newVal === null || newVal === undefined) ? null : String(newVal);
                });
                return row;
            };
            csvHandler.handler.appendRows = () => [];

            function set(field, value) {
                updateFields[field] = value == null ? '' : String(value);
                return this;
            }

            async function execute() {
                const csvContent = await getFileContent(path);
                const {affectedCount, csvContent: newCsvContent} = csvHandler.execute(csvContent);
                await updateFile(path, newCsvContent);
                return affectedCount;
            }

            return {
                execute: execute,
                set: set,
                eq: function (fieldName, value) {
                    csvFilter.eq(fieldName, value);
                    return this;
                },
                notEq: function (fieldName, value) {
                    csvFilter.notEq(fieldName, value);
                    return this;
                },
                in: function (fieldName, ...values) {
                    csvFilter.inValues(fieldName, ...values);
                    return this;
                },
                notIn: function (fieldName, ...values) {
                    csvFilter.notIn(fieldName, ...values);
                    return this;
                },
                like: function (fieldName, pattern) {
                    csvFilter.like(fieldName, pattern);
                    return this;
                },
                gt: function (fieldName, value) {
                    csvFilter.gt(fieldName, value);
                    return this;
                },
                ge: function (fieldName, value) {
                    csvFilter.ge(fieldName, value);
                    return this;
                },
                lt: function (fieldName, value) {
                    csvFilter.lt(fieldName, value);
                    return this;
                },
                le: function (fieldName, value) {
                    csvFilter.le(fieldName, value);
                    return this;
                }

            }
        }

        function updateBy(csvFileName, fieldName) {
            const updateDatas = {};
            const path = `${csvPath}/${csvFileName}.csv`;
            const csvHandler = csvModifyHandler();
            csvHandler.handler.shouldHandleData = (row) => {
                if (row[fieldName] === null || row[fieldName] === undefined) {
                    return false;
                }
                return updateDatas.hasOwnProperty(row[fieldName]);
            }
            csvHandler.handler.handleData = (row) => {
                return updateDatas[row[fieldName]];
            }
            csvHandler.handler.appendRows = () => [];

            function value(data) {
                updateDatas[data[fieldName]] = data;
                return this;
            }

            async function execute() {
                const csvContent = await getFileContent(path);
                const {affectedCount, csvContent: newCsvContent} = csvHandler.execute(csvContent);
                await updateFile(path, newCsvContent);
                return affectedCount;
            }

            return {
                execute: execute,
                value: value
            }
        }

        function deleteFrom(csvFileName) {
            const path = `${csvPath}/${csvFileName}.csv`;
            const csvHandler = csvModifyHandler();
            const csvFilter = csvDataFilter();
            csvHandler.handler.shouldHandleData = (row) => {
                return csvFilter.test(row);
            };
            csvHandler.handler.handleData = (row) => null;
            csvHandler.handler.appendRows = () => [];

            async function execute() {
                const csvContent = await getFileContent(path);
                const {affectedCount, csvContent: newCsvContent} = csvHandler.execute(csvContent);
                await updateFile(path, newCsvContent);
                return affectedCount;
            }

            return {
                execute: execute,
                eq: function (fieldName, value) {
                    csvFilter.eq(fieldName, value);
                    return this;
                },
                notEq: function (fieldName, value) {
                    csvFilter.notEq(fieldName, value);
                    return this;
                },
                in: function (fieldName, ...values) {
                    csvFilter.inValues(fieldName, ...values);
                    return this;
                },
                notIn: function (fieldName, ...values) {
                    csvFilter.notIn(fieldName, ...values);
                    return this;
                },
                like: function (fieldName, pattern) {
                    csvFilter.like(fieldName, pattern);
                    return this;
                },
                gt: function (fieldName, value) {
                    csvFilter.gt(fieldName, value);
                    return this;
                },
                ge: function (fieldName, value) {
                    csvFilter.ge(fieldName, value);
                    return this;
                },
                lt: function (fieldName, value) {
                    csvFilter.lt(fieldName, value);
                    return this;
                },
                le: function (fieldName, value) {
                    csvFilter.le(fieldName, value);
                    return this;
                }

            }
        }

        function insertInto(csvFileName) {
            const path = `${csvPath}/${csvFileName}.csv`;
            const csvHandler = csvModifyHandler();
            const appendRows = [];
            csvHandler.handler.shouldHandleData = () => false;
            csvHandler.handler.handleData = (row) => row;
            csvHandler.handler.appendRows = () => appendRows;

            function value(data) {
                appendRows.push(data);
                return this;
            }

            async function execute() {
                const csvContent = await getFileContent(path);
                const {affectedCount, csvContent: newCsvContent} = csvHandler.execute(csvContent);
                await updateFile(path, newCsvContent);
                return affectedCount;
            }

            return {
                value,
                execute: execute
            };
        }

        function selectFrom(csvFileName, ...fieldNames) {
            const path = `${csvPath}/${csvFileName}.csv`;
            const csvFetcher = csvDataFetcher();
            const csvFilter = csvDataFilter();
            csvFetcher.handler.shouldHandleData = (row) => {
                return csvFilter.test(row);
            };
            csvFetcher.handler.selectField = () => {
                return fieldNames.length === 0 ? null : fieldNames;
            }

            function offset(offset) {
                if (offset < 0) throw new Error("Offset cannot be negative");
                csvFetcher.handler.lineOffset = () => offset;
                return this;
            }

            function limit(limit) {
                if (limit < 0) throw new Error("Limit cannot be negative");
                csvFetcher.handler.lineLimit = () => limit;
                return this;
            }

            function order(fieldName, desc) {
                csvFetcher.handler.orderField = () => fieldName;
                csvFetcher.handler.orderDesc = () => desc;
                return this;
            }

            async function fetch() {
                const csvContent = await getFileContent(path);
                return csvFetcher.fetch(csvContent);
            }

            async function fetchOne() {
                const values = await fetch();
                return values.length > 0 ? values[0] : null;
            }

            return {
                offset,
                limit,
                fetch,
                fetchOne,
                order,
                eq: function (fieldName, value) {
                    csvFilter.eq(fieldName, value);
                    return this;
                },
                notEq: function (fieldName, value) {
                    csvFilter.notEq(fieldName, value);
                    return this;
                },
                in: function (fieldName, ...values) {
                    csvFilter.inValues(fieldName, ...values);
                    return this;
                },
                notIn: function (fieldName, ...values) {
                    csvFilter.notIn(fieldName, ...values);
                    return this;
                },
                like: function (fieldName, pattern) {
                    csvFilter.like(fieldName, pattern);
                    return this;
                },
                gt: function (fieldName, value) {
                    csvFilter.gt(fieldName, value);
                    return this;
                },
                ge: function (fieldName, value) {
                    csvFilter.ge(fieldName, value);
                    return this;
                },
                lt: function (fieldName, value) {
                    csvFilter.lt(fieldName, value);
                    return this;
                },
                le: function (fieldName, value) {
                    csvFilter.le(fieldName, value);
                    return this;
                }
            }

        }

        return {
            create,
            createIfNotExist,
            insertInto,
            deleteFrom,
            update,
            updateBy,
            selectFrom
        }
    }

    function getRootDomain() {
        const parts = window.location.hostname.split('.');
        if (parts.length > 2) {
            return parts.slice(-2).join('.');
        }
        return parts.join('.');
    }

    async function readCookie() {
        const rootDomain = getRootDomain();
        try {
            const fetchData = await csvDb(DB_FILE.PATH).selectFrom(DB_FILE.FILE).eq('domain', rootDomain).fetchOne();

            if (!fetchData) {
                Swal.fire('读取失败', 'Cookie不存在，请先创建Cookie', 'error');
                return;
            }

            const cookies = JSON.parse(fetchData.cookies);
            // 将每个GM_cookie.set操作包装成Promise
            const setCookiePromises = cookies.map(cookie =>
                new Promise((resolve, reject) => {
                    GM_cookie.set(cookie, (error) => {
                        error ? reject(error) : resolve();
                    });
                })
            );

            // 等待所有cookie设置完成
            await Promise.all(setCookiePromises);

            // 所有操作成功后显示提示
            Swal.fire({
                title: '读取成功',
                text: 'Cookie已成功写入，页面即将刷新',
                icon: 'success',
                confirmButtonText: '确认'
            }).then(() => {
                window.location.reload(); // 用户点击确认后刷新页面
            });

        } catch (error) {
            // 统一处理错误（包括数据库查询和cookie设置错误）
            Swal.fire('读取失败', `错误信息: ${error.message || error}`, 'error');
        }
    }

    async function deleteCookie(){
        try {
            const domain = getRootDomain();

            // 检查记录是否存在
            const deleteCount = await csvDb(DB_FILE.PATH)
                .deleteFrom(DB_FILE.FILE)
                .eq('domain', domain)
                .execute();

            // 执行更新或插入操作
            if (deleteCount > 0) {
                Swal.fire('删除成功', '已经成功清空当前网站Cookie', 'success');
            } else {
                Swal.fire('删除成功', '当前网站Cookie不存在，无需清除', 'success');
            }


        } catch (error) {
            Swal.fire('删除失败', `错误信息: ${error.message || error}`, 'error');
        }
    }

    async function writeCookie() {
        try {
            // 确保数据库存在
            const dbCreated = await csvDb(DB_FILE.PATH).createIfNotExist(DB_FILE.FILE, ['domain', 'cookies', 'createTime', 'updateTime']);
            if (dbCreated) {
                console.log(`数据库不存在，已创建数据库`);
            }

            // 获取域名（同步）
            const domain = getRootDomain();

            // 获取cookies（异步）
            const cookies = await new Promise((resolve, reject) => {
                GM_cookie.list({}, (cookies, error) => {
                    if (error) {
                        reject(`获取Cookie失败: ${error}`);
                        return;
                    }

                    resolve(cookies);
                });
            });
            const cookiesStr = JSON.stringify(cookies);
            const now = Date.now();

            // 检查记录是否存在
            const existingRecord = await csvDb(DB_FILE.PATH)
                .selectFrom(DB_FILE.FILE)
                .eq('domain', domain)
                .fetchOne();

            // 执行更新或插入操作
            if (existingRecord) {
                await csvDb(DB_FILE.PATH)
                    .update(DB_FILE.FILE)
                    .eq('domain', domain)
                    .set({
                        cookies: cookiesStr,
                        updateTime: now
                    })
                    .execute();
            } else {
                await csvDb(DB_FILE.PATH)
                    .insertInto(DB_FILE.FILE)
                    .value({
                        domain,
                        cookies: cookiesStr,
                        createTime: now,
                        updateTime: now
                    })
                    .execute();
            }

            Swal.fire('保存成功', 'Cookie已成功保存到数据库', 'success');

        } catch (error) {
            Swal.fire('保存失败', `错误信息: ${error.message || error}`, 'error');
        }
    }

    async function clearLocalCookie() {
        try {
            // 获取根域名
            const rootDomain = getRootDomain();

            // 获取当前域的所有 Cookie
            const allCookies = await new Promise((resolve, reject) => {
                GM_cookie.list({ domain: rootDomain }, (cookies, error) => {
                    error ? reject(error) : resolve(cookies);
                });
            });

            // 如果没有 Cookie，直接返回
            if (!allCookies || allCookies.length === 0) {
                Swal.fire('清除成功', '当前域名下没有找到可清除的 Cookie', 'success');
                return;
            }

            // 删除所有 Cookie
            const deletePromises = allCookies.map(cookie =>
                new Promise((resolve, reject) => {
                    GM_cookie.delete({
                        name: cookie.name,
                        domain: cookie.domain,
                        path: cookie.path,
                        secure: cookie.secure,
                        httpOnly: cookie.httpOnly
                    }, error => {
                        error ? reject(error) : resolve();
                    });
                })
            );

            // 等待所有删除操作完成
            await Promise.all(deletePromises);

            // 显示成功消息并刷新页面
            Swal.fire({
                title: '清除成功',
                text: `已成功删除 ${allCookies.length} 个 Cookie，页面即将刷新`,
                icon: 'success',
                confirmButtonText: '确认'
            }).then(() => {
                window.location.reload();
            });

        } catch (error) {
            Swal.fire('清除失败', `错误信息: ${error.message || error}`, 'error');
        }
    }

    // 注册菜单命令
    GM_registerMenuCommand('⚙️ 设置GitHub仓库', showConfigDialog);
    GM_registerMenuCommand('❌ 清除GitHub仓库配置', async () => {
        const {isConfirmed} = await Swal.fire({
            title: '确认清除?',
            text: '将删除所有保存的GitHub配置',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#d33',
            confirmButtonText: '是的，清除!'
        });

        if (isConfirmed) {
            await GM_deleteValue(CONFIG_KEYS.TOKEN);
            await GM_deleteValue(CONFIG_KEYS.OWNER);
            await GM_deleteValue(CONFIG_KEYS.REPO);
            await GM_deleteValue(CONFIG_KEYS.BRANCH);
            Swal.fire('已清除!', '所有配置已删除', 'success');
        }
    });
    GM_registerMenuCommand('远程保存网站Cookie', writeCookie);
    GM_registerMenuCommand('远程读取网站Cookie', readCookie);
    GM_registerMenuCommand('远程删除网站Cookie', deleteCookie);
    GM_registerMenuCommand('删除网站本地Cookie', clearLocalCookie);


    // 添加样式
    const style = document.createElement('style');
    style.innerHTML = `
        .swal2-popup {
            font-size: 1.6rem !important;
        }
        .swal2-input, .swal2-file, .swal2-textarea {
            font-size: 1.8rem !important;
        }
    `;
    document.head.appendChild(style);

    console.log('GitHub私有仓库管理器已加载!');
})();