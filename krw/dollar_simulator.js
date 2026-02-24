class DollarInvestmentSimulator {
    constructor() {
        this.PASSWORD = 'secret123';
        this.authenticated = false;
        this.exchangeRateData = [];
        this.chart = null;
        this.macdChart = null;
        this.lastUpdate = null;
        this.csvLoaded = false;
        this.csvLastDate = null;
        this.apiSource = null;

        // 원화고정납입 관련
        this.reserveHistory = [];
        this.reserveDepletionDate = null;
        this.reserveWarnings = [];

        // 프리셋 정의
        this.presets = {
            standard: { totalPeriodYears: 10, interval: 'monthly', dollarPremium: 300, fixedPaymentMultiplier: 110, purchasePeriodYears: 7, holdingPeriodYears: 3, interestRate: 24.8, compoundRate: 4.3, reserveInterestRate: 3.25, additionalBudget: 0, additionalStrategy: 'monthly', additionalPremiumLimitPct: 200, insuredAmount: 0, enrollmentType: 'simple', maintenanceBonus1: 0, maintenanceBonus2: 0 },
            long: { totalPeriodYears: 20, interval: 'monthly', dollarPremium: 500, fixedPaymentMultiplier: 110, purchasePeriodYears: 7, holdingPeriodYears: 3, interestRate: 24.8, compoundRate: 4.3, reserveInterestRate: 3.25, additionalBudget: 0, additionalStrategy: 'monthly', additionalPremiumLimitPct: 200, insuredAmount: 0, enrollmentType: 'simple', maintenanceBonus1: 0, maintenanceBonus2: 0, additionalEnabled: true }
        };

        this.initializeDate();
        this.setupEventListeners();

        // 전체화면 변경 시 차트 리사이즈
        document.addEventListener('fullscreenchange', () => {
            document.querySelectorAll('.fullscreen-btn').forEach(b => b.textContent = '⛶');
            if (document.fullscreenElement) {
                const btn = document.fullscreenElement.querySelector('.fullscreen-btn');
                if (btn) btn.textContent = '✕';
            }
            setTimeout(() => {
                if (this.chart) this.chart.resize();
                if (this.macdChart) this.macdChart.resize();
            }, 100);
        });
    }

    // ========================
    // 인증
    // ========================
    authenticate(password) {
        const pwd = password || document.getElementById('passwordInput').value;
        const authError = document.getElementById('authError');
        if (pwd === this.PASSWORD) {
            this.authenticated = true;
            document.getElementById('authOverlay').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';
            this.initialize();
            return true;
        } else if (!password) {
            authError.innerHTML = '<div class="error">암호가 틀렸습니다.</div>';
        }
        return false;
    }

    tryAutoAuth() {
        const params = new URLSearchParams(window.location.search);
        const key = params.get('key');
        if (key) {
            if (this.authenticate(key)) {
                // URL에서 key 파라미터 제거 (보안)
                const url = new URL(window.location);
                url.searchParams.delete('key');
                window.history.replaceState({}, '', url);
                return true;
            }
        }
        // 세션 기반 자동인증 (같은 탭에서 새로고침 시)
        if (sessionStorage.getItem('sim_auth') === 'true') {
            return this.authenticate(this.PASSWORD);
        }
        return false;
    }

    async initialize() {
        sessionStorage.setItem('sim_auth', 'true');
        // PT 모드 버튼 표시
        const ptBtn = document.getElementById('ptModeBtn');
        if (ptBtn) ptBtn.style.display = 'flex';
        this.updateLastUpdateTime();
        await this.loadExchangeRateData();
        this.initPeriodSlider();
        // URL에서 고객 프리셋 파라미터 로드
        this.loadFromUrlParams();
        this.updateSimulation();
    }

    initializeDate() {
        const today = new Date();
        document.getElementById('endDate').value = today.toISOString().split('T')[0];
    }

    setupEventListeners() {
        document.getElementById('passwordInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.authenticate();
        });
        document.getElementById('purchasePeriod').addEventListener('change', () => { this.autoSetHoldingPeriod(); this.validatePeriods(); this.toggleDollarPremiumFields(); });
        document.getElementById('holdingPeriod').addEventListener('change', () => { this.validatePeriods(); this.toggleDollarPremiumFields(); });
        document.getElementById('timeRange').addEventListener('change', () => { this.autoSetHoldingPeriod(); this.validatePeriods(); this.toggleDollarPremiumFields(); });
        document.getElementById('dollarPremium').addEventListener('change', () => this.toggleDollarPremiumFields());
        // 전략 설명 동적 업데이트
        const strategyEl = document.getElementById('additionalStrategy');
        if (strategyEl) {
            strategyEl.addEventListener('change', () => {
                const desc = document.getElementById('strategyDesc');
                if (!desc) return;
                const descs = {
                    monthly: '* 저축전환 기간 동안 매월 같은 금액을 납입',
                    ma_cross: '* 환율이 하락 추세일 때만 매수하여 저점 포착',
                    below_avg: '* 현재 환율이 그동안 평균보다 낮을 때만 매수',
                    value_avg: '* 목표 금액에 맞춰 자동으로 매수량 조절 (저환율 시 더 많이)',
                    front_loaded: '* 초기에 70% 집중 투입하여 복리 효과 극대화',
                    grid: '* 환율 구간에 따라 차등 매수 (저환율 3배, 고환율 0.5배)',
                    core_satellite: '* 60%는 즉시 일시납, 40%는 매월 분산 투입'
                };
                desc.textContent = descs[strategyEl.value] || descs.monthly;
            });
        }
        // 가입유형 설명 동적 업데이트
        const enrollmentEl = document.getElementById('enrollmentType');
        if (enrollmentEl) {
            enrollmentEl.addEventListener('change', () => this.updateEnrollmentTypeDesc());
        }
        // 초기 필드 표시/숨김
        this.toggleDollarPremiumFields();
    }

    autoSetHoldingPeriod() {
        const totalPeriod = parseFloat(document.getElementById('timeRange').value);
        const purchasePeriod = parseFloat(document.getElementById('purchasePeriod').value);
        const holding = Math.max(0, totalPeriod - purchasePeriod);
        document.getElementById('holdingPeriod').value = holding;
    }

    validatePeriods() {
        const totalPeriod = parseFloat(document.getElementById('timeRange').value);
        const purchasePeriod = parseFloat(document.getElementById('purchasePeriod').value);
        const holdingPeriod = parseFloat(document.getElementById('holdingPeriod').value);
        document.getElementById('purchasePeriod').max = totalPeriod;
        document.getElementById('holdingPeriod').max = totalPeriod - purchasePeriod;
        if (purchasePeriod > totalPeriod) {
            document.getElementById('purchasePeriod').value = totalPeriod;
        }
        if (holdingPeriod > totalPeriod - purchasePeriod) {
            document.getElementById('holdingPeriod').value = Math.max(0, totalPeriod - purchasePeriod);
        }
    }

    // ========================
    // 데이터 로딩: CSV + Frankfurter API
    // ========================
    showLoadingProgress(message) {
        const el = document.getElementById('loadingProgress');
        if (el) {
            el.style.display = 'flex';
            el.querySelector('.loading-progress-text').textContent = message;
        }
    }

    hideLoadingProgress() {
        const el = document.getElementById('loadingProgress');
        if (el) el.style.display = 'none';
    }

    async loadExchangeRateData() {
        if (this.csvLoaded && this.exchangeRateData.length > 0) return;
        try {
            this.showLoadingProgress('환율 데이터를 불러오는 중...');
            await this.loadCsvData();
            this.showLoadingProgress('최신 환율을 확인하는 중...');
            await this.fetchApiData();
            this.lastUpdate = new Date();
            this.updateLastUpdateTime();
            this.hideLoadingProgress();
        } catch (error) {
            this.hideLoadingProgress();
            if (this.exchangeRateData.length > 0) {
                this.lastUpdate = new Date();
                this.updateLastUpdateTime();
            } else {
                this.showError('환율 데이터를 불러올 수 없습니다. 인터넷 연결을 확인해 주세요.');
            }
        }
    }

    async loadCsvData() {
        if (window.location.protocol === 'file:') {
            throw new Error('웹 서버를 통해 접속해 주세요. 직접 파일 열기로는 실행할 수 없습니다.');
        }
        const response = await fetch('krw.csv');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        let text = await response.text();
        // UTF-8 BOM 제거
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        const lines = text.trim().split(/\r?\n/);
        this.exchangeRateData = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const comma = line.indexOf(',');
            if (comma === -1) continue;
            const dateStr = line.substring(0, comma).trim();
            const rateStr = line.substring(comma + 1).trim();
            const rate = parseFloat(rateStr);
            if (isNaN(rate)) continue;
            this.exchangeRateData.push({ date: new Date(dateStr), rate });
        }
        this.exchangeRateData.sort((a, b) => a.date - b.date);
        this.csvLoaded = true;
        this.csvLastDate = this.exchangeRateData.length > 0
            ? this.exchangeRateData[this.exchangeRateData.length - 1].date
            : null;
        console.log(`CSV 로드 완료: ${this.exchangeRateData.length}개 (${this.exchangeRateData[0]?.date.toISOString().split('T')[0]} ~ ${this.csvLastDate?.toISOString().split('T')[0]})`);
    }

    async fetchApiData() {
        if (!this.csvLastDate) return;

        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];

        // CSV 마지막 날짜 다음 날부터 조회
        const startDate = new Date(this.csvLastDate);
        startDate.setDate(startDate.getDate() + 1);
        const startStr = startDate.toISOString().split('T')[0];

        // CSV가 이미 오늘까지 커버하면 API 불필요
        if (startDate >= today) {
            this.apiSource = null;
            console.log('CSV가 최신 데이터까지 포함, API 호출 건너뜀');
            return;
        }

        // localStorage 캐시 확인 (24시간 TTL)
        const cacheKey = 'krw_api_cache';
        const cached = this.loadCache(cacheKey);
        if (cached && cached.endDate === todayStr) {
            this.mergeApiRates(cached.rates);
            this.apiSource = cached.source;
            console.log(`캐시 사용: ${Object.keys(cached.rates).length}개 (${cached.source})`);
            return;
        }

        // Frankfurter API 호출 (1순위)
        try {
            const url = `https://api.frankfurter.dev/v1/${startStr}..${todayStr}?base=USD&symbols=KRW`;
            const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
            if (!res.ok) throw new Error(`Frankfurter HTTP ${res.status}`);
            const data = await res.json();
            if (data.rates && Object.keys(data.rates).length > 0) {
                const rates = {};
                for (const [dateStr, val] of Object.entries(data.rates)) {
                    rates[dateStr] = val.KRW;
                }
                this.mergeApiRates(rates);
                this.saveCache(cacheKey, { rates, endDate: todayStr, source: 'Frankfurter (ECB)' });
                this.apiSource = 'Frankfurter (ECB)';
                console.log(`Frankfurter API: ${Object.keys(rates).length}개 로드`);
                return;
            }
        } catch (e) {
            console.warn('Frankfurter API 실패:', e.message);
        }

        // ExchangeRate-API 폴백 (2순위, 최신 1건만)
        try {
            const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(3000) });
            if (!res.ok) throw new Error(`ER-API HTTP ${res.status}`);
            const data = await res.json();
            if (data.result === 'success' && data.rates?.KRW) {
                const rateDate = new Date(data.time_last_update_utc).toISOString().split('T')[0];
                const rates = { [rateDate]: data.rates.KRW };
                this.mergeApiRates(rates);
                this.saveCache(cacheKey, { rates, endDate: todayStr, source: 'ExchangeRate-API' });
                this.apiSource = 'ExchangeRate-API';
                console.log(`ExchangeRate-API 폴백: ${rateDate} = ${data.rates.KRW}`);
                return;
            }
        } catch (e) {
            console.warn('ExchangeRate-API 폴백 실패:', e.message);
        }

        this.apiSource = null;
        console.warn('모든 API 실패, CSV 데이터만 사용');
    }

    mergeApiRates(rates) {
        const existingDates = new Set(
            this.exchangeRateData.map(d => d.date.toISOString().split('T')[0])
        );
        let added = 0;
        for (const [dateStr, rate] of Object.entries(rates)) {
            if (!existingDates.has(dateStr) && !isNaN(rate)) {
                this.exchangeRateData.push({ date: new Date(dateStr), rate });
                added++;
            }
        }
        if (added > 0) {
            this.exchangeRateData.sort((a, b) => a.date - b.date);
        }
        console.log(`API 데이터 병합: ${added}개 추가 (총 ${this.exchangeRateData.length}개)`);
    }

    loadCache(key) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const data = JSON.parse(raw);
            // 24시간 TTL
            if (Date.now() - data.timestamp > 24 * 60 * 60 * 1000) return null;
            return data;
        } catch { return null; }
    }

    saveCache(key, data) {
        try {
            localStorage.setItem(key, JSON.stringify({ ...data, timestamp: Date.now() }));
        } catch (e) {
            console.warn('캐시 저장 실패:', e.message);
        }
    }

    // ========================
    // 시뮬레이션 업데이트
    // ========================
    async updateSimulation() {
        if (!this.authenticated) return;
        this.showLoading();
        this.updateSliderVisual();
        try {
            await this.loadExchangeRateData();
            if (this.exchangeRateData.length === 0) {
                throw new Error('환율 데이터가 없습니다.');
            }
            const result = this.runSimulation();
            this.lastResult = result;
            // 추가납입 체크 ON + 예산 0이면 → 자동 계산된 금액을 UI에 반영
            const additionalCb = document.getElementById('additionalEnabled');
            const additionalBudgetEl = document.getElementById('additionalBudget');
            if (additionalCb?.checked && additionalBudgetEl && parseFloat(additionalBudgetEl.value) === 0) {
                additionalBudgetEl.value = Math.round(result.totalBeforeConversion);
            }
            this.updateSummaryBanner(result);
            this.updateResultsTab(result);
            await this.updateStrategyComparison(result);
            this.updateTimeline(result);
            this.updateChartTab(result);
            this.updateScheduleTab(result);
            this.updateComparisonTab(result);
            this.updatePeriodInfo();
        } catch (error) {
            this.showError('시뮬레이션 중 문제가 발생했습니다. 설정값을 확인해 주세요.');
        }
    }

    // ========================
    // 설정값
    // ========================
    getConfig() {
        return {
            totalPeriodYears: parseFloat(document.getElementById('timeRange').value),
            interval: document.getElementById('interval').value,
            endDate: document.getElementById('endDate').value,
            purchasePeriodYears: parseFloat(document.getElementById('purchasePeriod').value),
            holdingPeriodYears: parseFloat(document.getElementById('holdingPeriod').value),
            interestRate: parseFloat(document.getElementById('interestRate').value),
            compoundRate: parseFloat(document.getElementById('compoundRate').value),
            dollarPremium: parseFloat(document.getElementById('dollarPremium').value),
            fixedPaymentMultiplier: parseFloat(document.getElementById('fixedPaymentMultiplier').value),
            reserveInterestRate: parseFloat(document.getElementById('reserveInterestRate').value),
            additionalEnabled: document.getElementById('additionalEnabled')?.checked || false,
            additionalBudget: parseFloat(document.getElementById('additionalBudget').value) || 0,
            additionalStrategy: document.getElementById('additionalStrategy')?.value || 'monthly',
            additionalPremiumLimitPct: parseFloat(document.getElementById('additionalPremiumLimitPct').value) || 200,
            insuredAmount: parseFloat(document.getElementById('insuredAmount').value) || 0,
            enrollmentType: document.getElementById('enrollmentType')?.value || 'simple',
            maintenanceBonus1: parseFloat(document.getElementById('maintenanceBonus1').value) || 0,
            maintenanceBonus2: parseFloat(document.getElementById('maintenanceBonus2').value) || 0
        };
    }

    // ========================
    // 기술적 지표: 이동평균선 & MACD
    // ========================
    calculateSMA(rates, period) {
        const result = new Array(rates.length).fill(null);
        for (let i = period - 1; i < rates.length; i++) {
            let sum = 0;
            for (let j = i - period + 1; j <= i; j++) sum += rates[j];
            result[i] = sum / period;
        }
        return result;
    }

    calculateEMA(values, period) {
        const result = new Array(values.length).fill(null);
        const k = 2 / (period + 1);
        let sum = 0, count = 0, seedIdx = -1;
        for (let i = 0; i < values.length; i++) {
            if (values[i] === null) continue;
            sum += values[i];
            count++;
            if (count === period) { seedIdx = i; break; }
        }
        if (seedIdx === -1) return result;
        result[seedIdx] = sum / period;
        let prev = result[seedIdx];
        for (let i = seedIdx + 1; i < values.length; i++) {
            if (values[i] === null) continue;
            result[i] = values[i] * k + prev * (1 - k);
            prev = result[i];
        }
        return result;
    }

    calculateMACD(rates) {
        const ema12 = this.calculateEMA(rates, 12);
        const ema26 = this.calculateEMA(rates, 26);
        const macdLine = rates.map((_, i) =>
            (ema12[i] !== null && ema26[i] !== null) ? ema12[i] - ema26[i] : null
        );
        const signal = this.calculateEMA(macdLine, 9);
        const histogram = macdLine.map((v, i) =>
            (v !== null && signal[i] !== null) ? v - signal[i] : null
        );
        return { macdLine, signal, histogram };
    }

    // ========================
    // Phase 1-3: 핵심 시뮬레이션 (원화고정납입)
    // ========================
    runSimulation(overrides) {
        const config = this.getConfig();
        if (overrides) {
            if (overrides.dollarPremium !== undefined) config.dollarPremium = overrides.dollarPremium;
        }

        const endDate = new Date(config.endDate);
        const totalPeriodYears = config.totalPeriodYears;
        const purchasePeriodYears = config.purchasePeriodYears;
        const holdingPeriodYears = config.holdingPeriodYears;
        const conversionPeriodYears = totalPeriodYears - (purchasePeriodYears + holdingPeriodYears);

        const startDate = new Date(endDate);
        startDate.setFullYear(startDate.getFullYear() - Math.floor(totalPeriodYears));
        startDate.setMonth(startDate.getMonth() - Math.round((totalPeriodYears % 1) * 12));

        const purchaseEndDate = new Date(startDate);
        purchaseEndDate.setFullYear(purchaseEndDate.getFullYear() + Math.floor(purchasePeriodYears));
        purchaseEndDate.setMonth(purchaseEndDate.getMonth() + Math.round((purchasePeriodYears % 1) * 12));

        const holdingEndDate = new Date(purchaseEndDate);
        holdingEndDate.setFullYear(holdingEndDate.getFullYear() + Math.floor(holdingPeriodYears));
        holdingEndDate.setMonth(holdingEndDate.getMonth() + Math.round((holdingPeriodYears % 1) * 12));

        // 데이터 범위 체크 (1990-03-02 이후)
        const minDataDate = this.exchangeRateData[0]?.date || new Date('1990-03-02');
        const actualStart = startDate < minDataDate ? new Date(minDataDate) : startDate;

        const filteredData = this.exchangeRateData.filter(item =>
            item.date >= actualStart && item.date <= endDate
        );
        if (filteredData.length === 0) {
            throw new Error('해당 기간의 환율 데이터를 찾을 수 없습니다.');
        }

        const purchaseDates = this.getPurchaseDates(actualStart, purchaseEndDate, config.interval);
        if (purchaseDates.length === 0) {
            throw new Error('납입 날짜를 생성할 수 없습니다. 기간 설정을 확인해주세요.');
        }

        // 각 납입일의 환율 조회 (이진 탐색)
        const purchaseRates = purchaseDates.map(date => this.findClosestRate(date));

        const dollarPremium = config.dollarPremium;
        // 연복리 → 월환산: (1 + 연이율)^(1/12) - 1
        const monthlyReserveRate = Math.pow(1 + config.reserveInterestRate / 100, 1/12) - 1;

        // 원화고정납입: fixedKrw = 달러보험료 × 시작시점 환율 × 배율(100~130%)
        const startRate = this.findClosestRate(actualStart);
        const fixedKrw = dollarPremium * startRate * (config.fixedPaymentMultiplier / 100);

        // UI에 자동 계산된 고정납입보험료 표시
        const calcDisplay = document.getElementById('calculatedFixedKrw');
        if (calcDisplay) {
            calcDisplay.textContent = `→ 월 ${Math.round(fixedKrw).toLocaleString()}원 (기준환율 ${startRate.toFixed(0)}원)`;
        }

        let reserveBalance = 0;
        let totalKrwPaid = 0;
        let totalDollarPurchased = 0;
        let reserveHistory = [];
        let reserveDepletionDate = null;
        let reserveWarnings = [];
        const cumulativeAveragePrices = [];

        for (let i = 0; i < purchaseRates.length; i++) {
            const rate = purchaseRates[i];
            const date = purchaseDates[i];

            // 1회차: 적립/인출 메커니즘 없이 기본 보험료만 납입
            if (i === 0) {
                const krwEquivalent = dollarPremium * rate;
                totalKrwPaid += krwEquivalent;
                totalDollarPurchased += dollarPremium;
                cumulativeAveragePrices.push(totalKrwPaid / totalDollarPurchased);
                reserveHistory.push({
                    date: new Date(date), balance: 0,
                    action: 'none', actionAmount: 0, rate,
                    krwPaid: krwEquivalent, extraKrw: 0,
                    dollarPremium, krwEquivalent
                });
                continue;
            }
            // 2회차 이후: 원화고정납입 메커니즘 적용
            if (reserveBalance > 0) {
                reserveBalance *= (1 + monthlyReserveRate);
            }
            const krwEquivalent = dollarPremium * rate;
            let action, actionAmount, actionUncoveredKrw = 0;

            if (krwEquivalent <= fixedKrw) {
                // 환율 하락: 차액을 달러로 추가 적립 (reserve에만 반영)
                const surplusKrw = fixedKrw - krwEquivalent;
                const extraDollars = surplusKrw / rate;
                reserveBalance += extraDollars;
                totalKrwPaid += fixedKrw;
                totalDollarPurchased += dollarPremium;  // 기본보험료만
                action = 'deposit';
                actionAmount = extraDollars;
            } else {
                // 환율 상승: 적립액에서 부족분 인출
                const deficitKrw = krwEquivalent - fixedKrw;
                const withdrawDollars = deficitKrw / rate;

                if (reserveBalance >= withdrawDollars) {
                    reserveBalance -= withdrawDollars;
                    totalKrwPaid += fixedKrw;
                    totalDollarPurchased += dollarPremium;
                    action = 'withdraw';
                    actionAmount = withdrawDollars;
                } else {
                    // 적립액 소진
                    const coveredDollars = reserveBalance;
                    const uncoveredKrw = deficitKrw - (coveredDollars * rate);
                    totalKrwPaid += fixedKrw + uncoveredKrw;
                    totalDollarPurchased += dollarPremium;
                    if (!reserveDepletionDate) {
                        reserveDepletionDate = new Date(date);
                    }
                    reserveWarnings.push(`${date.toISOString().split('T')[0]}: 적립액 소진 — 원화 추가 ${Math.round(uncoveredKrw).toLocaleString()}원 부담`);
                    reserveBalance = 0;
                    action = 'depleted';
                    actionAmount = coveredDollars;
                    actionUncoveredKrw = uncoveredKrw;
                }
            }
            // 누적 평균 (총 달러 자산 기준: 기본보험료 + 적립액)
            const totalDollarPosition = totalDollarPurchased + reserveBalance;
            const effectiveRate = totalKrwPaid / totalDollarPosition;
            cumulativeAveragePrices.push(effectiveRate);

            reserveHistory.push({
                date: new Date(date), balance: reserveBalance,
                action, actionAmount, rate,
                krwPaid: (action === 'depleted') ? fixedKrw + actionUncoveredKrw : fixedKrw,
                extraKrw: actionUncoveredKrw,
                dollarPremium, krwEquivalent
            });
        }

        const totalInvestment = totalKrwPaid;
        const finalRate = filteredData[filteredData.length - 1].rate;

        const basicPremiumTotal = totalDollarPurchased;  // dollarPremium × 납입횟수
        const reserveAfterPayment = reserveBalance;  // 납입기간 종료 시점 적립금

        // 거치기간 동안 적립금 월복리 계속 적용
        const holdingMonths = Math.round(holdingPeriodYears * 12);
        for (let m = 0; m < holdingMonths; m++) {
            if (reserveBalance > 0) {
                reserveBalance *= (1 + monthlyReserveRate);
            }
        }
        const finalReserveBalance = reserveBalance;

        // 기본보험료: 약정이자 적용 (보험사 보장)
        const contractInterest = basicPremiumTotal * (config.interestRate / 100);
        const contractReturn = basicPremiumTotal + contractInterest;

        // 추가적립액: reserveInterestRate 월복리만 (별도 약정이자 없음)
        const finalReserveValue = finalReserveBalance;

        // 해약환급금 = 기본보험료 반환 + 추가적립액
        const totalBeforeConversion = contractReturn + finalReserveValue;

        // 저축전환: 해약환급금 전액 → 저축보험 이전, compoundRate 적용
        const finalUnits = conversionPeriodYears > 0
            ? totalBeforeConversion * Math.pow(1 + config.compoundRate / 100, conversionPeriodYears)
            : totalBeforeConversion;

        // 기본 평균 매입 환율 (납입기간까지)
        const totalDollarPosition = basicPremiumTotal + finalReserveBalance;
        const basicAveragePrice = totalDollarPosition > 0 ? totalInvestment / totalDollarPosition : 0;

        // ========================
        // 저축전환 후 추가납입 (전략 기반)
        // ========================
        // 추가납입: 체크박스 ON일 때만 실행
        const additionalEnabled = config.additionalEnabled || false;
        // 예산이 0이면 저축전환 시점 해약환급금을 자동 사용
        const additionalBudget = additionalEnabled ? (config.additionalBudget || totalBeforeConversion) : 0;
        const additionalStrategy = config.additionalStrategy || 'monthly';
        const additionalLimitPct = (config.additionalPremiumLimitPct || 200) / 100;
        let additionalHistory = [];
        let additionalTotalKrw = 0;
        let additionalTotalDollars = 0;
        let additionalTotalCompounded = 0;
        let additionalLimitReachedDate = null;
        // 추가납입 포함 누적 평균 추적
        let runningTotalKrw = totalInvestment;
        let runningTotalDollars = totalDollarPosition;
        const additionalAveragePrices = [];  // { date, avgPrice } 추가납입 구간 평균 변화

        if (additionalBudget > 0 && conversionPeriodYears > 0) {
            const totalLimit = totalBeforeConversion * additionalLimitPct;
            const budget = Math.min(additionalBudget, totalLimit);

            // 저축전환 기간 월별 날짜 생성
            const conversionStart = new Date(holdingEndDate);
            const conversionMonths = Math.round(conversionPeriodYears * 12);
            const monthlyDates = [];
            for (let m = 0; m < conversionMonths; m++) {
                const date = new Date(conversionStart);
                date.setMonth(date.getMonth() + m);
                if (date >= endDate) break;
                monthlyDates.push({ date, monthIndex: m });
            }

            // 전략별 매수 계획 생성 [{date, amount}]
            const purchasePlan = this.getAdditionalPurchasePlan(
                additionalStrategy, monthlyDates, budget, totalLimit, basicAveragePrice, conversionPeriodYears
            );

            let cumulativeAdditional = 0;

            for (const { date, amount } of purchasePlan) {
                // 한도 체크
                if (cumulativeAdditional >= totalLimit) {
                    if (!additionalLimitReachedDate) additionalLimitReachedDate = new Date(date);
                    break;
                }

                let actualPremium = amount;
                if (cumulativeAdditional + actualPremium > totalLimit) {
                    actualPremium = totalLimit - cumulativeAdditional;
                }
                if (actualPremium <= 0) continue;

                const netDollars = actualPremium;
                const rate = this.findClosestRate(date);
                const krwPaid = actualPremium * rate;

                // 잔여 저축전환 기간에 대한 복리
                const monthIdx = monthlyDates.findIndex(d => d.date.getTime() === date.getTime());
                const m = monthIdx >= 0 ? monthlyDates[monthIdx].monthIndex : 0;
                const remainingYears = conversionPeriodYears - (m / 12);
                const compounded = remainingYears > 0
                    ? netDollars * Math.pow(1 + config.compoundRate / 100, remainingYears)
                    : netDollars;

                cumulativeAdditional += actualPremium;
                additionalTotalKrw += krwPaid;
                additionalTotalDollars += netDollars;
                additionalTotalCompounded += compounded;

                // 누적 평균 갱신 (추가납입 포함)
                runningTotalKrw += krwPaid;
                runningTotalDollars += netDollars;

                additionalHistory.push({
                    date: new Date(date),
                    rate,
                    premium: actualPremium,
                    fee: 0,
                    netDollars,
                    compounded,
                    krwPaid,
                    cumulative: cumulativeAdditional,
                    totalLimit
                });

                additionalAveragePrices.push({
                    date: new Date(date),
                    avgPrice: runningTotalKrw / runningTotalDollars
                });
            }
        }

        // 최종 평균 매입 환율 (추가납입 포함)
        const finalAveragePrice = runningTotalDollars > 0 ? runningTotalKrw / runningTotalDollars : basicAveragePrice;

        // finalUnits = (기본보험료+약정이자+추가적립) × 저축전환복리 — reserve 이미 포함
        const finalValue = finalUnits * finalRate;
        const finalValueTotal = finalValue + (additionalTotalCompounded * finalRate);
        const totalInvestmentWithAdditional = totalInvestment + additionalTotalKrw;
        const profitRate = totalInvestmentWithAdditional > 0
            ? ((finalValueTotal - totalInvestmentWithAdditional) / totalInvestmentWithAdditional) * 100
            : 0;

        return {
            totalInvestment: totalInvestmentWithAdditional, finalValue: finalValueTotal, profitRate,
            finalAveragePrice, totalUnits: finalUnits, finalRate,
            purchaseDates, purchaseRates, cumulativeAveragePrices,
            allData: filteredData, startDate: actualStart,
            purchaseEndDate, holdingEndDate, endDate,
            conversionPeriodYears,
            reserveHistory, reserveDepletionDate, reserveWarnings,
            finalReserveBalance, finalReserveValue,
            totalDollarPurchased, fixedKrw, reserveAfterPayment,
            useDollarPremiumMode: true,
            // 해약환급금 구성요소
            basicPremiumTotal,       // 기본보험료 원금 ($)
            contractInterest,        // 약정이자 ($)
            contractReturn,          // 기본보험료 + 약정이자 ($)
            totalBeforeConversion,   // 해약환급금 합계 ($) = contractReturn + reserve
            // 추가납입 관련
            additionalHistory, additionalTotalKrw, additionalTotalDollars,
            additionalTotalCompounded, additionalLimitReachedDate,
            additionalAveragePrices, additionalStrategy,
            basicAveragePrice,
            basicTotalInvestment: totalInvestment,  // 기본납입 원화만
            config
        };
    }

    // ========================
    // 투자 시뮬레이션 공통 로직
    // ========================
    _runInvestmentSimulation(insuranceResult, options) {
        const { monthlyRate, feeMultiplier, taxCalc } = options;

        let balance = 0;
        let totalKrwPaid = 0;
        let totalUsdPurchased = 0;
        let totalInterest = 0;
        const history = [];

        // 1) 납입기간
        for (let i = 0; i < insuranceResult.reserveHistory.length; i++) {
            const entry = insuranceResult.reserveHistory[i];
            const krwPaid = entry.krwPaid;
            const rate = entry.rate;

            if (i > 0 && balance > 0) {
                const interest = balance * monthlyRate;
                totalInterest += interest;
                balance += interest;
            }

            const usdBought = krwPaid / (rate * feeMultiplier);
            balance += usdBought;
            totalKrwPaid += krwPaid;
            totalUsdPurchased += usdBought;

            history.push({
                date: new Date(entry.date),
                rate, krwPaid, usdBought, balance,
                interest: i > 0 ? balance * monthlyRate / (1 + monthlyRate) : 0,
                avgRate: totalKrwPaid / totalUsdPurchased,
                phase: 'payment'
            });
        }

        // 2) 거치기간
        const holdingMonths = Math.round(
            ((insuranceResult.holdingEndDate - insuranceResult.purchaseEndDate) / (1000 * 60 * 60 * 24 * 30.44))
        );
        if (holdingMonths > 0) {
            const holdingStart = new Date(insuranceResult.purchaseEndDate);
            for (let m = 0; m < holdingMonths; m++) {
                const interest = balance * monthlyRate;
                totalInterest += interest;
                balance += interest;
                const date = new Date(holdingStart);
                date.setMonth(date.getMonth() + m + 1);
                history.push({
                    date, rate: this.findClosestRate(date),
                    krwPaid: 0, usdBought: 0, balance,
                    interest, avgRate: totalKrwPaid / totalUsdPurchased,
                    phase: 'holding'
                });
            }
        }

        // 3) 전환기간
        const conversionMonths = Math.round(insuranceResult.conversionPeriodYears * 12);
        if (conversionMonths > 0) {
            const convStart = new Date(insuranceResult.holdingEndDate);
            const addMap = new Map();
            if (insuranceResult.additionalHistory) {
                for (const ah of insuranceResult.additionalHistory) {
                    addMap.set(ah.date.getTime(), ah.krwPaid);
                }
            }
            for (let m = 0; m < conversionMonths; m++) {
                const date = new Date(convStart);
                date.setMonth(date.getMonth() + m);

                if (balance > 0) {
                    const interest = balance * monthlyRate;
                    totalInterest += interest;
                    balance += interest;
                }

                const addKrw = addMap.get(date.getTime()) || 0;
                let addUsd = 0;
                if (addKrw > 0) {
                    const rate = this.findClosestRate(date);
                    addUsd = addKrw / (rate * feeMultiplier);
                    balance += addUsd;
                    totalKrwPaid += addKrw;
                    totalUsdPurchased += addUsd;
                }

                history.push({
                    date, rate: this.findClosestRate(date),
                    krwPaid: addKrw, usdBought: addUsd, balance,
                    interest: balance > 0 ? balance * monthlyRate / (1 + monthlyRate) : 0,
                    avgRate: totalUsdPurchased > 0 ? totalKrwPaid / totalUsdPurchased : 0,
                    phase: 'conversion'
                });
            }
        }

        // 4) 만기: 세금 계산
        const tax = taxCalc(totalInterest, insuranceResult.finalRate);
        const finalUsd = balance - tax;
        const finalRate = insuranceResult.finalRate;
        const finalKrw = finalUsd * finalRate;
        const profitRate = totalKrwPaid > 0
            ? ((finalKrw - totalKrwPaid) / totalKrwPaid) * 100
            : 0;

        return {
            history, holdingMonths,
            totalKrwPaid, totalUsdPurchased, totalInterest,
            tax, finalUsd, finalKrw, finalRate, profitRate,
            averageRate: totalUsdPurchased > 0 ? totalKrwPaid / totalUsdPurchased : 0
        };
    }

    // ========================
    // 은행 달러 예금 시뮬레이션
    // ========================
    runBankSimulation(insuranceResult) {
        const exchangeFee = parseFloat(document.getElementById('bankExchangeFee')?.value) || 1.75;
        const annualRate = parseFloat(document.getElementById('bankInterestRate')?.value) || 3.5;
        const taxRate = parseFloat(document.getElementById('bankTaxRate')?.value) || 15.4;
        const monthlyRate = Math.pow(1 + annualRate / 100, 1 / 12) - 1;

        const sim = this._runInvestmentSimulation(insuranceResult, {
            monthlyRate,
            feeMultiplier: 1 + exchangeFee / 100,
            taxCalc: (interest) => interest * (taxRate / 100)
        });

        return {
            bankHistory: sim.history,
            totalKrwPaid: sim.totalKrwPaid,
            totalUsdPurchased: sim.totalUsdPurchased,
            totalInterest: sim.totalInterest,
            tax: sim.tax,
            finalUsd: sim.finalUsd,
            finalKrw: sim.finalKrw,
            finalRate: sim.finalRate,
            profitRate: sim.profitRate,
            averageRate: sim.averageRate,
            atPaymentEnd: this._phaseSnapshot(sim.history, 'payment'),
            atHoldingEnd: sim.holdingMonths > 0
                ? this._phaseSnapshot(sim.history, 'holding')
                : null,
            atMaturity: { finalUsd: sim.finalUsd, finalKrw: sim.finalKrw, profitRate: sim.profitRate, totalKrwPaid: sim.totalKrwPaid, tax: sim.tax, totalInterest: sim.totalInterest }
        };
    }

    // 기간별 스냅샷 헬퍼
    _phaseSnapshot(history, phase) {
        const entries = history.filter(h => h.phase === phase);
        if (entries.length === 0) return null;
        const last = entries[entries.length - 1];
        let krwSum = 0;
        for (const h of history) {
            krwSum += h.krwPaid;
            if (h === last) break;
        }
        return {
            date: last.date,
            balance: last.balance,
            rate: last.rate,
            krwValue: last.balance * last.rate,
            totalKrwPaid: krwSum,
            avgRate: last.avgRate
        };
    }

    // ========================
    // 사망보험금 계산
    // ========================
    calculateDeathBenefit(config, year, paidPremiumUsd, bonusAccum, reserveUsd) {
        if (!config.insuredAmount || config.insuredAmount <= 0) return null;

        const isSimple = config.enrollmentType === 'simple';
        const maxPct = isSimple ? 150 : 200;
        const escalatedPct = Math.min(105 + year * 5, maxPct);
        const escalatedAmount = config.insuredAmount * escalatedPct / 100;
        const baseDeath = Math.max(escalatedAmount, paidPremiumUsd);
        const totalDeath = baseDeath + bonusAccum + reserveUsd;

        // 간편가입형 0~2년: 일반사망 시 50%
        const simpleDeathWarning = isSimple && year < 2;

        return {
            year,
            escalatedPct,
            escalatedAmount,
            paidPremiumUsd,
            bonusAccum,
            reserveUsd,
            baseDeath,
            totalDeath,
            simpleDeathWarning
        };
    }

    getDeathBenefitTimeline(insuranceResult) {
        const config = insuranceResult.config;
        if (!config.insuredAmount || config.insuredAmount <= 0) return [];

        const purchaseYears = config.purchasePeriodYears;
        const holdingYears = config.holdingPeriodYears;
        const conversionYears = insuranceResult.conversionPeriodYears || 0;
        // 저축전환 시점 = 사망보험금 소멸 시점
        const conversionStartYear = Math.round(purchaseYears + holdingYears);
        // 사망보험금은 전환 전까지만 유효
        const maxYear = conversionStartYear;

        // 유지보너스 발생 시점 (전환 전에만 의미)
        const bonus1Year = Math.round(purchaseYears * 2);
        const bonus2Year = Math.round(purchaseYears * 3);

        // 기납입보험료 계산 (월납 기준)
        const monthlyUsd = config.dollarPremium > 0 ? config.dollarPremium : 0;
        const totalPremiumMonths = Math.round(purchaseYears * 12);

        // 현재 시점 (가입일로부터의 경과 년수 근사)
        const startDate = insuranceResult.startDate || insuranceResult.purchaseDates?.[0] || new Date();
        const now = new Date();
        const elapsedYears = Math.max(0, (now - new Date(startDate)) / (365.25 * 86400000));
        const currentYear = Math.min(Math.round(elapsedYears), maxYear);

        // 주요 년차 선별 (전환 시점까지만)
        const keyYears = new Set();
        for (const y of [0, 1, 2, 3, 5, 7, 10, 15, 20, 25, 30]) {
            if (y <= maxYear) keyYears.add(y);
        }
        keyYears.add(Math.round(purchaseYears));
        keyYears.add(conversionStartYear);
        if (bonus1Year <= maxYear) keyYears.add(bonus1Year);
        if (bonus2Year <= maxYear) keyYears.add(bonus2Year);
        if (currentYear <= maxYear) keyYears.add(currentYear);

        const timeline = [];
        let bonusAccum = 0;

        for (let y = 0; y <= maxYear; y++) {
            if (!keyYears.has(y)) continue;

            // 기납입보험료 (해당 년차까지)
            const paidMonths = Math.min(y * 12, totalPremiumMonths);
            const paidPremiumUsd = paidMonths * monthlyUsd;

            // 유지보너스 누적 (전환 전 시점에 발생한 것만)
            if (y >= bonus1Year && bonus1Year <= maxYear) bonusAccum = config.maintenanceBonus1;
            if (y >= bonus2Year && bonus2Year <= maxYear) bonusAccum = config.maintenanceBonus1 + config.maintenanceBonus2;

            const db = this.calculateDeathBenefit(config, y, paidPremiumUsd, bonusAccum, 0);
            if (!db) continue;

            db.isCurrent = (y === currentYear);
            db.isBonus = (y === bonus1Year || y === bonus2Year) && y <= maxYear;
            db.isMax = (db.escalatedPct >= (config.enrollmentType === 'simple' ? 150 : 200));
            db.phase = y < purchaseYears ? '납입' : '거치';
            db.isConversionPoint = conversionYears > 0 && (y === conversionStartYear);

            timeline.push(db);
        }

        // 전환 후 소멸 정보 추가
        timeline.conversionStartYear = conversionStartYear;
        timeline.hasConversion = conversionYears > 0;

        return timeline;
    }

    // 사망보험금 전환 상태 판별 헬퍼
    _getDeathBenefitStatus(insuranceResult) {
        const tl = this.getDeathBenefitTimeline(insuranceResult);
        const hasConversion = tl.hasConversion;
        const startDt = insuranceResult.startDate || insuranceResult.purchaseDates?.[0] || new Date();
        const elapsed = Math.max(0, (new Date() - new Date(startDt)) / (365.25 * 86400000));
        const afterConversion = hasConversion && Math.round(elapsed) >= (tl.conversionStartYear || 0);
        const current = tl.find(t => t.isCurrent) || tl[tl.length - 1];
        const maxBenefit = current ? current.totalDeath : 0;
        return { timeline: tl, hasConversion, afterConversion, maxBenefit };
    }

    // ========================
    // ETF 시뮬레이션
    // ========================
    runEtfSimulation(insuranceResult) {
        const expenseRatio = parseFloat(document.getElementById('etfExpenseRatio')?.value) || 0.25;
        const bondYield = parseFloat(document.getElementById('etfBondYield')?.value) || 4.0;
        const accountType = document.getElementById('etfAccountType')?.value || 'general';
        const taxRate = parseFloat(document.getElementById('etfTaxRate')?.value) || 15.4;
        const netAnnualRate = (bondYield - expenseRatio) / 100;
        const monthlyRate = Math.pow(1 + netAnnualRate, 1 / 12) - 1;

        const sim = this._runInvestmentSimulation(insuranceResult, {
            monthlyRate,
            feeMultiplier: 1, // ETF: 환전수수료 없음
            taxCalc: (interest, finalRate) => {
                if (accountType === 'isa') {
                    const taxableKrw = Math.max(0, interest * finalRate - 2000000);
                    return (taxableKrw * 0.099) / finalRate;
                }
                // 일반/연금: 전체 이익 × 세율
                return interest * (taxRate / 100);
            }
        });

        return {
            etfHistory: sim.history,
            totalKrwPaid: sim.totalKrwPaid,
            totalUsdPurchased: sim.totalUsdPurchased,
            totalInterest: sim.totalInterest,
            tax: sim.tax,
            finalUsd: sim.finalUsd,
            finalKrw: sim.finalKrw,
            finalRate: sim.finalRate,
            profitRate: sim.profitRate,
            averageRate: sim.averageRate,
            accountType,
            atPaymentEnd: this._phaseSnapshot(sim.history, 'payment'),
            atHoldingEnd: sim.holdingMonths > 0
                ? this._phaseSnapshot(sim.history, 'holding')
                : null,
            atMaturity: { finalUsd: sim.finalUsd, finalKrw: sim.finalKrw, profitRate: sim.profitRate, totalKrwPaid: sim.totalKrwPaid, tax: sim.tax, totalInterest: sim.totalInterest }
        };
    }

    findClosestIndex(targetDate) {
        const data = this.exchangeRateData;
        let lo = 0, hi = data.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (data[mid].date < targetDate) lo = mid + 1;
            else hi = mid;
        }
        if (lo === 0) return 0;
        const prev = data[lo - 1], curr = data[lo];
        return (Math.abs(curr.date - targetDate) < Math.abs(prev.date - targetDate)) ? lo : lo - 1;
    }

    findClosestRate(targetDate) {
        return this.exchangeRateData[this.findClosestIndex(targetDate)].rate;
    }

    // Chart.js x축 날짜 포맷 (timestamp → YYYY.MM)
    _formatChartDate(value) {
        const d = new Date(value);
        return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0');
    }

    // 특정 날짜 기준 SMA 계산 (과거 period일간 평균)
    calculateSMAAtDate(targetDate, period) {
        const idx = this.findClosestIndex(targetDate);
        if (idx < period - 1) return null;
        let sum = 0;
        for (let i = idx - period + 1; i <= idx; i++) {
            sum += this.exchangeRateData[i].rate;
        }
        return sum / period;
    }

    // 추가납입 전략별 매수 계획 생성 [{date, amount}]
    // monthlyDates: [{date, monthIndex}], budget: USD, totalLimit: USD
    getAdditionalPurchasePlan(strategy, monthlyDates, budget, totalLimit, avgRate, conversionYears) {
        const dates = monthlyDates.map(d => d.date);
        const effectiveBudget = Math.min(budget, totalLimit);

        if (strategy === 'monthly') {
            const per = dates.length > 0 ? effectiveBudget / dates.length : 0;
            return dates.map(d => ({ date: d, amount: per }));
        }

        if (strategy === 'ma_cross') {
            const filtered = dates.filter(date => {
                const sma60 = this.calculateSMAAtDate(date, 60);
                const sma120 = this.calculateSMAAtDate(date, 120);
                if (sma60 === null || sma120 === null) return false;
                return sma60 < sma120;
            });
            const per = filtered.length > 0 ? effectiveBudget / filtered.length : 0;
            return filtered.map(d => ({ date: d, amount: per }));
        }

        if (strategy === 'below_avg') {
            const filtered = dates.filter(date => {
                const rate = this.findClosestRate(date);
                return rate <= avgRate;
            });
            const per = filtered.length > 0 ? effectiveBudget / filtered.length : 0;
            return filtered.map(d => ({ date: d, amount: per }));
        }

        // 가치평균법 (Value Averaging)
        // 목표 KRW 자산가치 경로를 설정하고, 실제와의 차이만큼 투자
        // 환율 하락(달러 저가) → 기존 포지션 KRW가치 하락 → 더 많이 매수
        // 환율 상승(달러 고가) → 기존 포지션 KRW가치 상승 → 적게 매수/스킵
        if (strategy === 'value_avg') {
            const plan = [];
            // 기준 환율: 전환 시작 시점의 환율
            const startRate = dates.length > 0 ? this.findClosestRate(dates[0]) : avgRate;
            const targetKrwTotal = effectiveBudget * startRate;
            const monthlyKrwTarget = targetKrwTotal / dates.length;
            let cumulativeUsd = 0;
            let totalAllocated = 0;

            for (let i = 0; i < dates.length; i++) {
                const rate = this.findClosestRate(dates[i]);
                const currentKrwValue = cumulativeUsd * rate;
                const targetKrwValue = monthlyKrwTarget * (i + 1);
                const gapKrw = targetKrwValue - currentKrwValue;

                if (gapKrw > 0) {
                    // KRW 차이를 현재 환율로 USD 변환, 단 전체 예산의 20% 상한
                    let usdAmount = gapKrw / rate;
                    usdAmount = Math.min(usdAmount, effectiveBudget * 0.2);
                    usdAmount = Math.min(usdAmount, effectiveBudget - totalAllocated);
                    if (usdAmount > 0) {
                        plan.push({ date: dates[i], amount: usdAmount });
                        cumulativeUsd += usdAmount;
                        totalAllocated += usdAmount;
                    }
                }
                // gapKrw <= 0: 목표 초과 → 이번 달 스킵
            }
            return plan;
        }

        // 시간가중 체감식 (Front-loaded)
        // 초기에 많이, 후기에 적게 — 선형 감소 가중치
        // 먼저 넣은 돈이 더 오래 복리 적용되므로 최적
        if (strategy === 'front_loaded') {
            const n = dates.length;
            if (n === 0) return [];
            // 가중치: (n - i) → 첫 달이 n, 마지막 달이 1
            const weights = dates.map((_, i) => n - i);
            const weightSum = weights.reduce((a, b) => a + b, 0);
            return dates.map((d, i) => ({
                date: d,
                amount: effectiveBudget * (weights[i] / weightSum)
            }));
        }

        // 구간매수 / 그리드 전략 (Grid Trading)
        // 환율 구간별 매수 배수 차등: 저환율 → 3×, 고환율 → 0.5×
        // 기준: 기본납입 평균 매입가 대비 비율
        if (strategy === 'grid') {
            const tiers = [
                { threshold: 0.90, multiplier: 3.0 },  // 평균 대비 -10% 이하
                { threshold: 0.95, multiplier: 2.0 },  // 평균 대비 -5% 이하
                { threshold: 1.00, multiplier: 1.5 },  // 평균 이하
                { threshold: 1.05, multiplier: 1.0 },  // 평균 대비 +5% 이하
                { threshold: Infinity, multiplier: 0.5 } // 평균 대비 +5% 초과
            ];
            const rawWeights = dates.map(d => {
                const rate = this.findClosestRate(d);
                const ratio = rate / avgRate;
                for (const tier of tiers) {
                    if (ratio <= tier.threshold) return tier.multiplier;
                }
                return 0.5;
            });
            const weightSum = rawWeights.reduce((a, b) => a + b, 0);
            if (weightSum === 0) return [];
            return dates.map((d, i) => ({
                date: d,
                amount: effectiveBudget * (rawWeights[i] / weightSum)
            }));
        }

        // 코어+새틀라이트 (Core-Satellite Hybrid)
        // 코어 60%: 전환 첫 달 일시납 (복리 극대화)
        // 새틀라이트 40%: 나머지를 매월 균등 분배
        if (strategy === 'core_satellite') {
            if (dates.length === 0) return [];
            const coreRatio = 0.6;
            const coreBudget = effectiveBudget * coreRatio;
            const satelliteBudget = effectiveBudget - coreBudget;
            const plan = [{ date: dates[0], amount: coreBudget }];
            if (dates.length > 1) {
                const perMonth = satelliteBudget / (dates.length - 1);
                for (let i = 1; i < dates.length; i++) {
                    plan.push({ date: dates[i], amount: perMonth });
                }
            }
            return plan;
        }

        // fallback: monthly
        const per = dates.length > 0 ? effectiveBudget / dates.length : 0;
        return dates.map(d => ({ date: d, amount: per }));
    }

    getPurchaseDates(startDate, endDate, interval) {
        const dates = [];
        let cur = new Date(startDate);
        while (cur < endDate) {
            dates.push(new Date(cur));
            switch (interval) {
                case 'daily': cur.setDate(cur.getDate() + 1); break;
                case 'weekly': cur.setDate(cur.getDate() + 7); break;
                case 'monthly': cur.setMonth(cur.getMonth() + 1); break;
                case 'yearly': cur.setFullYear(cur.getFullYear() + 1); break;
            }
        }
        return dates;
    }

    // ========================
    // Phase 2-1: 요약 배너
    // ========================
    updateSummaryBanner(result) {
        const banner = document.getElementById('summaryBanner');
        if (!banner) return;
        const cfg = result.config;
        const intervalKo = { daily: '매일', weekly: '매주', monthly: '매월', yearly: '매년' }[cfg.interval] || '';
        const profitClass = result.profitRate >= 0 ? 'positive' : 'negative';
        const profitSign = result.profitRate >= 0 ? '+' : '';

        const customerName = document.getElementById('customerName')?.value;
        const namePrefix = customerName ? `<strong>${customerName}</strong> 고객님 | ` : '';
        let text = `${namePrefix}${intervalKo} ${Math.round(result.fixedKrw).toLocaleString()}원 고정납입 (보험료 $${cfg.dollarPremium}) × ${cfg.purchasePeriodYears}년 → 총 $${Math.round(result.totalDollarPurchased).toLocaleString()} 납입`;
        if (result.additionalHistory.length > 0) {
            const strategyNames = { monthly: '균등', ma_cross: '하락추세', below_avg: '저점매수', value_avg: '목표맞춤', front_loaded: '초기집중', grid: '구간매수', core_satellite: '일시납+분산' };
            const sName = strategyNames[result.additionalStrategy] || '정액';
            text += `, 추가납입(${sName}) ${result.additionalHistory.length}회 → $${Math.round(result.additionalTotalCompounded).toLocaleString()}`;
        }
        text += `, <span class="banner-profit ${profitClass}">수익률 ${profitSign}${result.profitRate.toFixed(1)}%</span>`;
        banner.innerHTML = text;
        banner.style.display = 'block';
    }

    // ========================
    // Phase 1-4 + 2-2: 결과 탭
    // ========================
    updateResultsTab(result) {
        const grid = document.getElementById('metricsGrid');
        const cfg = result.config;
        const numPayments = result.purchaseDates.length;
        const reserveAfterPayment = result.reserveAfterPayment || 0;
        const reserveInterestDuringDeferral = result.finalReserveBalance - reserveAfterPayment;
        const totalFinalUSD = result.totalUnits + (result.additionalTotalCompounded || 0);
        const totalProfit = result.finalValue - result.totalInvestment;

        // 환차익 = 총 만기 USD × (만기환율 - 평균매입환율)
        const exchangeGain = totalFinalUSD * (result.finalRate - result.finalAveragePrice);
        // 이자수익 = 총 수익 - 환차익
        const interestGain = totalProfit - exchangeGain;

        // 요약 카드
        let html = `
            <div class="metric-card metric-card--investment">
                <div class="metric-label">총 납입 원화</div>
                <div class="metric-value">${Math.round(result.totalInvestment).toLocaleString()}원</div>
            </div>
            <div class="metric-card metric-card--value">
                <div class="metric-label">만기 자산 가치</div>
                <div class="metric-value">${Math.round(result.finalValue).toLocaleString()}원</div>
            </div>
            <div class="metric-card metric-card--profit">
                <div class="metric-label">수익률</div>
                <div class="metric-value ${result.profitRate >= 0 ? 'positive' : 'negative'}">${result.profitRate >= 0 ? '+' : ''}${result.profitRate.toFixed(2)}%</div>
            </div>
            <div class="metric-card metric-card--rate">
                <div class="metric-label">평균 매입 환율</div>
                <div class="metric-value">${result.finalAveragePrice.toFixed(0)}원</div>
            </div>`;

        // 돈의 흐름
        let stepNum = 1;
        html += `<div style="grid-column: 1 / -1;" class="money-flow">`;

        // Step 1: 납입기간
        html += `
            <div class="flow-step">
                <div class="flow-step-header">
                    <span class="flow-step-number">${stepNum++}</span>
                    납입기간 (${cfg.purchasePeriodYears}년, ${numPayments}회)
                </div>
                <div class="flow-row">
                    <span>월 보험료</span>
                    <span>$${cfg.dollarPremium}</span>
                </div>
                <div class="flow-row">
                    <span>원화납입보험료 (할증 ${cfg.fixedPaymentMultiplier}%)</span>
                    <span>${Math.round(result.fixedKrw).toLocaleString()}원/월</span>
                </div>
                <div class="flow-row dim">
                    <span>기준환율 ${result.allData.length > 0 ? this.findClosestRate(result.startDate).toFixed(0) : '?'}원 × $${cfg.dollarPremium} × ${cfg.fixedPaymentMultiplier}%</span>
                    <span></span>
                </div>
                <div class="flow-row">
                    <span>기본보험료 누적</span>
                    <span>$${cfg.dollarPremium} × ${numPayments}회 = $${result.basicPremiumTotal.toLocaleString()}</span>
                </div>
                <div class="flow-row">
                    <span>원화 총 납입</span>
                    <span>${Math.round(result.basicTotalInvestment).toLocaleString()}원</span>
                </div>
                <div class="flow-row accent">
                    <span>적립금 누적 (환율 차액분)</span>
                    <span>$${reserveAfterPayment.toFixed(2)}</span>
                </div>
                ${result.reserveDepletionDate ? `
                <div class="flow-depletion-warning">
                    적립금 소진: ${result.reserveDepletionDate.toISOString().split('T')[0]} — 이후 추가 원화 부담 발생
                </div>` : ''}
            </div>
            <div class="flow-connector">▼</div>`;

        // Step 2: 거치기간 (있을 때만)
        if (cfg.holdingPeriodYears > 0) {
            html += `
            <div class="flow-step">
                <div class="flow-step-header">
                    <span class="flow-step-number">${stepNum++}</span>
                    거치기간 (${cfg.holdingPeriodYears}년)
                </div>
                <div class="flow-row dim">
                    <span>보험료 납입 없음, 적립금에 부리이율 적용</span>
                    <span></span>
                </div>
                <div class="flow-row">
                    <span>적립금 부리 (${cfg.reserveInterestRate}% 연복리)</span>
                    <span>$${reserveAfterPayment.toFixed(2)} → $${result.finalReserveBalance.toFixed(2)}</span>
                </div>
                <div class="flow-row highlight">
                    <span>적립금 이자 수익</span>
                    <span>+$${reserveInterestDuringDeferral.toFixed(2)}</span>
                </div>
            </div>
            <div class="flow-connector">▼</div>`;
        }

        // Step 3: 해약환급금
        html += `
            <div class="flow-step">
                <div class="flow-step-header">
                    <span class="flow-step-number">${stepNum++}</span>
                    해약환급금
                </div>
                <div class="flow-row">
                    <span>기본보험료 원금</span>
                    <span>$${result.basicPremiumTotal.toFixed(2)}</span>
                </div>
                <div class="flow-row">
                    <span>+ 약정이율 (${cfg.interestRate}%)</span>
                    <span>+$${result.contractInterest.toFixed(2)}</span>
                </div>
                <div class="flow-row accent">
                    <span>+ 적립금</span>
                    <span>+$${result.finalReserveValue.toFixed(2)}</span>
                </div>
                <div class="flow-row subtotal">
                    <span>= 해약환급금</span>
                    <span>$${result.totalBeforeConversion.toFixed(2)}</span>
                </div>
            </div>`;

        // Step 4: 저축전환 (있을 때만)
        if (result.conversionPeriodYears > 0) {
            html += `
            <div class="flow-connector">▼</div>
            <div class="flow-step">
                <div class="flow-step-header">
                    <span class="flow-step-number">${stepNum++}</span>
                    저축전환 (공시이율 ${cfg.compoundRate}% × ${result.conversionPeriodYears.toFixed(1)}년)
                </div>
                <div class="flow-row">
                    <span>해약환급금 → 저축보험 이전</span>
                    <span>$${result.totalBeforeConversion.toFixed(2)}</span>
                </div>
                <div class="flow-row highlight">
                    <span>복리 성장 후</span>
                    <span>$${result.totalUnits.toFixed(2)}</span>
                </div>
                ${result.additionalHistory.length > 0 ? `
                <div class="flow-row">
                    <span>+ 추가납입 (${({monthly:'정액',ma_cross:'MA돌파',below_avg:'저점매수',value_avg:'가치평균',front_loaded:'초기집중',grid:'구간매수',core_satellite:'코어+위성'})[result.additionalStrategy]||'정액'}, ${result.additionalHistory.length}회, 복리 후)</span>
                    <span>+$${result.additionalTotalCompounded.toFixed(2)}</span>
                </div>
                <div class="flow-row dim">
                    <span>추가납입 원화: ${Math.round(result.additionalTotalKrw).toLocaleString()}원</span>
                    <span></span>
                </div>` : ''}
            </div>`;
        }

        // Step 5: 만기 환산
        html += `
            <div class="flow-connector">▼</div>
            <div class="flow-final">
                <div class="flow-step-header">
                    <span class="flow-step-number flow-step-number--final">${stepNum}</span>
                    만기 환산
                </div>
                <div class="flow-row">
                    <span>$${totalFinalUSD.toFixed(2)} × ${result.finalRate.toFixed(0)}원</span>
                    <span>= ${Math.round(result.finalValue).toLocaleString()}원</span>
                </div>
                <div class="flow-final-detail">
                    <span>환차익 ${exchangeGain >= 0 ? '+' : ''}${Math.round(exchangeGain).toLocaleString()}원</span>
                    <span>이자수익 ${interestGain >= 0 ? '+' : ''}${Math.round(interestGain).toLocaleString()}원</span>
                </div>
                <div class="flow-final-profit">
                    총 수익 ${totalProfit >= 0 ? '+' : ''}${Math.round(totalProfit).toLocaleString()}원 (${result.profitRate >= 0 ? '+' : ''}${result.profitRate.toFixed(1)}%)
                </div>
            </div>`;

        html += `</div>`; // money-flow 끝

        // 사망보험금 섹션
        const deathConfig = result.config;
        if (deathConfig.insuredAmount > 0) {
            const timeline = this.getDeathBenefitTimeline(result);
            const lastRate = result.endRate || result.avgRate || 1300;
            const convStartYear = timeline.conversionStartYear || 0;
            const hasConversion = timeline.hasConversion;

            // 현재 시점이 전환 전인지 확인
            const startDate = result.startDate || result.purchaseDates?.[0] || new Date();
            const elapsedYears = Math.max(0, (new Date() - new Date(startDate)) / (365.25 * 86400000));
            const isAfterConversion = hasConversion && Math.round(elapsedYears) >= convStartYear;

            // 현재 시점 사망보험금 찾기
            const currentEntry = timeline.find(t => t.isCurrent) || timeline[timeline.length - 1];
            const currentDeathUsd = currentEntry ? currentEntry.totalDeath : 0;
            const currentDeathKrw = currentDeathUsd * lastRate;

            html += `<div style="grid-column: 1 / -1;">`;

            if (isAfterConversion) {
                // 전환 후: 사망보험금 소멸 안내
                const lastEntry = timeline[timeline.length - 1];
                const maxDeathUsd = lastEntry ? lastEntry.totalDeath : 0;
                html += `<div class="metric-card metric-card--death" style="margin-bottom: 1rem; opacity: 0.7;">
                    <div class="metric-label">사망보험금 — 저축전환으로 소멸</div>
                    <div class="metric-value" style="text-decoration: line-through; font-size: 1.5rem;">$${Math.round(maxDeathUsd).toLocaleString()}</div>
                    <div class="metric-sub">전환 전 최대 사망보험금 (${convStartYear}년차 기준)</div>
                    <div class="metric-sub" style="margin-top:4px; color:#ef4444;">저축전환 후에는 해약환급금(적립금)만 수령 가능</div>
                </div>`;
            } else {
                // 전환 전: 현재 사망보험금 표시
                html += `<div class="metric-card metric-card--death" style="margin-bottom: 1rem;">
                    <div class="metric-label">사망보험금 (현재 ${currentEntry?.year || 0}년차)</div>
                    <div class="metric-value">$${Math.round(currentDeathUsd).toLocaleString()}</div>
                    <div class="metric-sub">${Math.round(currentDeathKrw).toLocaleString()}원 (환율 ${Math.round(lastRate).toLocaleString()}원 기준)</div>
                </div>`;
            }

            // 간편가입형 경고
            if (!isAfterConversion && currentEntry?.simpleDeathWarning) {
                html += `<div style="margin-bottom: 0.75rem;">
                    <span class="simple-warning">간편가입형 0~2년: 일반사망 시 보험금 50% 지급</span>
                </div>`;
            }

            // 체증 타임라인 테이블
            html += `<div style="overflow-x: auto;">
            <table class="death-benefit-table">
                <thead><tr>
                    <th>년차</th>
                    <th>구간</th>
                    <th>체증비율</th>
                    <th>체증금액($)</th>
                    <th>기납입보험료($)</th>
                    <th>유지보너스($)</th>
                    <th>사망보험금($)</th>
                    <th>원화환산</th>
                </tr></thead><tbody>`;

            for (const t of timeline) {
                const rowClass = t.isCurrent ? 'current-row' : t.isBonus ? 'bonus-row' : t.isMax ? 'max-row' : '';
                const krwValue = Math.round(t.totalDeath * lastRate);
                const label = t.isCurrent ? ` <span style="color:var(--primary-color);">◀ 현재</span>` : '';
                const bonusLabel = t.isBonus ? ` <span style="color:#f59e0b;">★</span>` : '';
                const convLabel = t.isConversionPoint ? ` <span style="color:#ef4444;">⚠ 전환</span>` : '';

                html += `<tr class="${rowClass}">
                    <td>${t.year}년${label}${bonusLabel}${convLabel}</td>
                    <td>${t.phase}</td>
                    <td>${t.escalatedPct}%</td>
                    <td>$${Math.round(t.escalatedAmount).toLocaleString()}</td>
                    <td>$${Math.round(t.paidPremiumUsd).toLocaleString()}</td>
                    <td>${t.bonusAccum > 0 ? '$' + Math.round(t.bonusAccum).toLocaleString() : '-'}</td>
                    <td><strong>$${Math.round(t.totalDeath).toLocaleString()}</strong></td>
                    <td>${krwValue.toLocaleString()}원</td>
                </tr>`;
            }

            html += `</tbody></table></div>`;

            // 저축전환 소멸 안내
            if (hasConversion) {
                html += `<div style="margin-top: 0.75rem; padding: 8px 12px; background: #fef2f2; border-left: 3px solid #ef4444; border-radius: 4px; font-size: 0.82rem; color: #991b1b;">
                    <strong>${convStartYear}년차 저축전환 시 사망보험금 소멸</strong> — 전환 후에는 종신보험 기능이 해제되어 체증 사망보험금이 없어지고, 해약환급금(적립금)만 수령 가능합니다.
                </div>`;
            }

            html += `</div>`; // grid-column 끝
        }

        grid.innerHTML = html;
    }

    // ========================
    // 전략 비교 테이블
    // ========================
    async updateStrategyComparison(currentResult) {
        const section = document.getElementById('strategyComparisonSection');
        if (!section) return;

        const additionalEnabled = currentResult.config.additionalEnabled || false;
        const budget = additionalEnabled ? (currentResult.config.additionalBudget || currentResult.totalBeforeConversion) : 0;
        if (budget <= 0 || currentResult.conversionPeriodYears <= 0) {
            section.style.display = 'none';
            return;
        }

        const strategies = [
            { key: 'monthly', name: '매월 균등' },
            { key: 'ma_cross', name: '하락추세 매수' },
            { key: 'below_avg', name: '저점 매수' },
            { key: 'value_avg', name: '목표 맞춤' },
            { key: 'front_loaded', name: '초기 집중' },
            { key: 'grid', name: '구간별 차등' },
            { key: 'core_satellite', name: '일시납+분산' }
        ];

        const el = document.getElementById('additionalStrategy');
        const currentStrategy = el.value;

        // 프로그레스 표시
        section.style.display = 'block';
        section.innerHTML = `<div class="strategy-comparison">
            <h3>📊 추가납입 전략 비교</h3>
            <div style="display:flex; align-items:center; gap:12px; padding:16px; background:var(--color-gray-50); border-radius:var(--radius-md);">
                <div class="spinner" style="width:20px;height:20px;border-width:2px;margin:0;flex-shrink:0;"></div>
                <span id="strategyProgressText" style="font-size:0.9em; color:var(--color-gray-600);">전략 비교 계산 중... (0/${strategies.length})</span>
            </div>
        </div>`;

        const results = [];
        // 비동기 순차 처리 (UI 프리징 방지)
        for (let i = 0; i < strategies.length; i++) {
            const s = strategies[i];
            el.value = s.key;
            await new Promise(resolve => setTimeout(resolve, 0)); // UI 업데이트 기회
            const r = this.runSimulation();
            results.push({
                ...s,
                buyCount: r.additionalHistory.length,
                additionalKrw: r.additionalTotalKrw,
                additionalCompounded: r.additionalTotalCompounded,
                totalInvestment: r.totalInvestment,
                finalValue: r.finalValue,
                profitRate: r.profitRate,
                avgRate: r.finalAveragePrice,
                totalProfit: r.finalValue - r.totalInvestment
            });
            const prog = document.getElementById('strategyProgressText');
            if (prog) prog.textContent = `전략 비교 계산 중... (${i + 1}/${strategies.length})`;
        }

        el.value = currentStrategy;

        results.sort((a, b) => b.finalValue - a.finalValue);
        const bestKey = results[0].key;

        let html = `<div class="strategy-comparison">
            <h3>📊 추가납입 전략 비교</h3>
            <table class="strategy-table">
                <thead><tr>
                    <th>전략</th><th>매수</th><th>추가납입 원화</th>
                    <th>복리 후($)</th><th>만기 자산</th><th>수익금</th><th>수익률</th>
                </tr></thead><tbody>`;

        results.forEach((r, i) => {
            const isCurrent = r.key === currentStrategy;
            const isBest = r.key === bestKey;
            const rowClass = [isCurrent ? 'strategy-current' : '', isBest ? 'strategy-best' : ''].filter(Boolean).join(' ');
            const rankHtml = i < 3 ? `<span class="strategy-rank strategy-rank-${i + 1}">${i + 1}</span>` : '';
            const badges = [
                isCurrent ? '<span class="strategy-badge strategy-badge-current">현재</span>' : '',
                isBest ? '<span class="strategy-badge strategy-badge-best">최적</span>' : ''
            ].filter(Boolean).join('');
            const profitClass = r.profitRate >= 0 ? 'positive' : 'negative';
            const sign = r.profitRate >= 0 ? '+' : '';

            html += `<tr class="${rowClass}">
                <td>${rankHtml}${r.name}${badges}</td>
                <td>${r.buyCount}회</td>
                <td>${Math.round(r.additionalKrw).toLocaleString()}원</td>
                <td>$${Math.round(r.additionalCompounded).toLocaleString()}</td>
                <td>${Math.round(r.finalValue).toLocaleString()}원</td>
                <td class="${profitClass}">${sign}${Math.round(r.totalProfit).toLocaleString()}원</td>
                <td class="${profitClass}">${sign}${r.profitRate.toFixed(1)}%</td>
            </tr>`;
        });

        html += `</tbody></table>`;
        html += `<div class="strategy-note">* 동일 설정에서 전략만 변경하여 비교합니다.</div>`;
        html += `</div>`;

        section.innerHTML = html;
    }

    // ========================
    // Phase 2-2: 타임라인
    // ========================
    updateTimeline(result) {
        const bar = document.getElementById('timelineBar');
        if (!bar) return;
        const cfg = result.config;
        const total = cfg.totalPeriodYears || 1;
        const pPct = (cfg.purchasePeriodYears / total * 100).toFixed(1);
        const hPct = (cfg.holdingPeriodYears / total * 100).toFixed(1);
        const cPct = (100 - parseFloat(pPct) - parseFloat(hPct)).toFixed(1);
        bar.innerHTML = `
            <div class="timeline-segment timeline-purchase" style="flex-basis:${pPct}%">납입 ${cfg.purchasePeriodYears}년</div>
            ${cfg.holdingPeriodYears > 0 ? `<div class="timeline-segment timeline-holding" style="flex-basis:${hPct}%">거치 ${cfg.holdingPeriodYears}년</div>` : ''}
            ${parseFloat(cPct) > 0 ? `<div class="timeline-segment timeline-conversion" style="flex-basis:${cPct}%">저축전환 ${result.conversionPeriodYears.toFixed(1)}년</div>` : ''}
        `;
    }

    // ========================
    // Phase 2-3: 프리셋
    // ========================
    applyPreset(type, event) {
        const p = this.presets[type];
        if (!p) return;
        document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active'));
        if (event?.target) event.target.classList.add('active');
        document.getElementById('timeRange').value = p.totalPeriodYears;
        document.getElementById('interval').value = p.interval;
        document.getElementById('dollarPremium').value = p.dollarPremium;
        document.getElementById('fixedPaymentMultiplier').value = p.fixedPaymentMultiplier || 120;
        document.getElementById('purchasePeriod').value = p.purchasePeriodYears;
        document.getElementById('holdingPeriod').value = p.holdingPeriodYears;
        document.getElementById('interestRate').value = p.interestRate;
        document.getElementById('compoundRate').value = p.compoundRate;
        document.getElementById('reserveInterestRate').value = p.reserveInterestRate;
        document.getElementById('additionalBudget').value = p.additionalBudget || 0;
        document.getElementById('additionalStrategy').value = p.additionalStrategy || 'monthly';
        document.getElementById('additionalPremiumLimitPct').value = p.additionalPremiumLimitPct || 200;
        const additionalCb = document.getElementById('additionalEnabled');
        if (additionalCb) additionalCb.checked = p.additionalEnabled || false;
        document.getElementById('insuredAmount').value = p.insuredAmount || 0;
        document.getElementById('enrollmentType').value = p.enrollmentType || 'simple';
        document.getElementById('maintenanceBonus1').value = p.maintenanceBonus1 || 0;
        document.getElementById('maintenanceBonus2').value = p.maintenanceBonus2 || 0;
        this.updateEnrollmentTypeDesc();
        this.toggleDollarPremiumFields();
        this.validatePeriods();
        this.updateSimulation();
    }

    toggleDollarPremiumFields() {
        const conversionYears = parseFloat(document.getElementById('timeRange').value)
            - parseFloat(document.getElementById('purchasePeriod').value)
            - parseFloat(document.getElementById('holdingPeriod').value);
        const showAdditional = conversionYears > 0;
        const additionalEnabled = document.getElementById('additionalEnabled')?.checked || false;
        // 추가납입 섹션: 전환기간 있을 때만 체크박스 표시
        const enableEl = document.getElementById('additionalEnableGroup');
        if (enableEl) enableEl.style.display = showAdditional ? 'block' : 'none';
        // 전략/예산/한도: 전환기간 있고 + 체크박스 ON일 때만 표시
        const detailIds = ['additionalPremiumSection', 'additionalStrategyGroup', 'additionalBudgetGroup', 'additionalPremiumLimitGroup'];
        detailIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = (showAdditional && additionalEnabled) ? 'block' : 'none';
        });
    }

    toggleAdditionalPremium() {
        this.toggleDollarPremiumFields();
        this.updateSimulation();
    }

    // ========================
    // 기간 분할 슬라이더
    // ========================
    initPeriodSlider() {
        const slider = document.getElementById('periodSlider');
        if (!slider) return;

        const track = slider.querySelector('.period-slider-track');
        const handle1 = document.getElementById('sliderHandle1');
        const handle2 = document.getElementById('sliderHandle2');
        let dragging = null;
        let dragFixedValue = 0;

        const getPos = (e) => {
            const rect = track.getBoundingClientRect();
            const x = e.touches ? e.touches[0].clientX : e.clientX;
            return Math.max(0, Math.min(1, (x - rect.left) / rect.width));
        };

        const snap = (years, total) => {
            const step = total >= 5 ? 0.5 : 0.25;
            return parseFloat((Math.round(years / step) * step).toFixed(2));
        };

        const onMove = (e) => {
            if (!dragging) return;
            e.preventDefault();
            const total = parseFloat(document.getElementById('timeRange').value) || 1;
            const pct = getPos(e);

            if (dragging === handle1) {
                // 납입/거치 경계 — 전환기간 고정
                let newPurchase = snap(pct * total, total);
                newPurchase = Math.max(0, Math.min(total - dragFixedValue, newPurchase));
                const newHolding = parseFloat((total - newPurchase - dragFixedValue).toFixed(1));
                document.getElementById('purchasePeriod').value = newPurchase;
                document.getElementById('holdingPeriod').value = Math.max(0, newHolding);
            } else {
                // 거치/전환 경계 — 납입기간 고정
                let boundary = snap(pct * total, total);
                boundary = Math.max(dragFixedValue, Math.min(total, boundary));
                const newHolding = parseFloat((boundary - dragFixedValue).toFixed(1));
                document.getElementById('holdingPeriod').value = Math.max(0, newHolding);
            }
            this.updateSliderVisual();
        };

        const onEnd = () => {
            if (dragging) dragging.classList.remove('active');
            dragging = null;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
            this.toggleDollarPremiumFields();
            this.updateSimulation();
        };

        const onStart = (handle, e) => {
            e.preventDefault();
            dragging = handle;
            handle.classList.add('active');
            const total = parseFloat(document.getElementById('timeRange').value) || 1;
            const purchase = parseFloat(document.getElementById('purchasePeriod').value) || 0;
            const holding = parseFloat(document.getElementById('holdingPeriod').value) || 0;
            if (handle === handle1) {
                dragFixedValue = Math.max(0, total - purchase - holding); // 전환기간 고정
            } else {
                dragFixedValue = purchase; // 납입기간 고정
            }
            document.addEventListener('mousemove', onMove, { passive: false });
            document.addEventListener('mouseup', onEnd);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
        };

        handle1.addEventListener('mousedown', (e) => onStart(handle1, e));
        handle1.addEventListener('touchstart', (e) => onStart(handle1, e), { passive: false });
        handle2.addEventListener('mousedown', (e) => onStart(handle2, e));
        handle2.addEventListener('touchstart', (e) => onStart(handle2, e), { passive: false });
    }

    updateSliderVisual() {
        const seg1 = document.getElementById('sliderSegPurchase');
        if (!seg1) return;

        const total = parseFloat(document.getElementById('timeRange').value) || 1;
        const purchase = Math.min(parseFloat(document.getElementById('purchasePeriod').value) || 0, total);
        const holding = Math.min(parseFloat(document.getElementById('holdingPeriod').value) || 0, total - purchase);
        const conversion = Math.max(0, parseFloat((total - purchase - holding).toFixed(1)));

        const pPct = purchase / total * 100;
        const hPct = holding / total * 100;
        const cPct = conversion / total * 100;

        const seg2 = document.getElementById('sliderSegHolding');
        const seg3 = document.getElementById('sliderSegConversion');
        const h1 = document.getElementById('sliderHandle1');
        const h2 = document.getElementById('sliderHandle2');

        seg1.style.flexBasis = pPct + '%';
        seg2.style.flexBasis = hPct + '%';
        seg3.style.flexBasis = cPct + '%';

        seg1.textContent = pPct > 18 ? `납입 ${purchase}년` : (pPct > 8 ? `${purchase}` : '');
        seg2.textContent = hPct > 18 ? `거치 ${holding}년` : (hPct > 8 ? `${holding}` : '');
        seg3.textContent = cPct > 18 ? `전환 ${conversion}년` : (cPct > 8 ? `${conversion}` : '');

        if (h1) h1.style.left = pPct + '%';
        if (h2) h2.style.left = (pPct + hPct) + '%';
    }

    // ========================
    // Phase 3: 차트
    // ========================
    updateChartTab(result) {
        this.renderChart(result);
        this.updatePriceMetrics(result);
    }

    renderChart(result) {
        const ctx = document.getElementById('priceChart').getContext('2d');
        if (this.chart) this.chart.destroy();
        if (this.macdChart) this.macdChart.destroy();

        // 데이터 샘플링 (성능)
        const maxPoints = 2000;
        const allData = result.allData;
        const step = Math.max(1, Math.floor(allData.length / maxPoints));
        const sampledIndices = [];
        for (let i = 0; i < allData.length; i++) {
            if (i % step === 0 || i === allData.length - 1) sampledIndices.push(i);
        }
        const sampledData = sampledIndices.map(i => allData[i]);

        // 이동평균선 계산 (전체 데이터 기반)
        const rates = allData.map(d => d.rate);
        const sma5 = this.calculateSMA(rates, 5);
        const sma20 = this.calculateSMA(rates, 20);
        const sma60 = this.calculateSMA(rates, 60);
        const sma120 = this.calculateSMA(rates, 120);

        const chartData1 = sampledData.map(item => ({ x: item.date.getTime(), y: item.rate }));
        const chartData2 = result.purchaseDates.map((date, i) => ({ x: date.getTime(), y: result.cumulativeAveragePrices[i] }));

        // 추가납입 구간의 평균 매입 환율 변화 반영
        if (result.additionalAveragePrices && result.additionalAveragePrices.length > 0) {
            // 납입기간 마지막 평균을 거치기간 끝까지 연장
            if (chartData2.length > 0) {
                const lastBasicAvg = chartData2[chartData2.length - 1].y;
                const holdingEndTs = result.holdingEndDate.getTime();
                if (holdingEndTs > chartData2[chartData2.length - 1].x) {
                    chartData2.push({ x: holdingEndTs, y: lastBasicAvg });
                }
            }
            // 추가납입 각 시점의 갱신된 평균 추가
            for (const ap of result.additionalAveragePrices) {
                chartData2.push({ x: ap.date.getTime(), y: ap.avgPrice });
            }
        }

        // 평균 매입 환율을 만기일까지 연장 (손익 영역 표시)
        if (chartData2.length > 0) {
            const lastAvg = chartData2[chartData2.length - 1].y;
            const endTs = result.endDate.getTime();
            if (endTs > chartData2[chartData2.length - 1].x) {
                chartData2.push({ x: endTs, y: lastAvg });
            }
        }

        const makeMaData = (maValues) => sampledIndices
            .filter(i => maValues[i] !== null)
            .map(i => ({ x: allData[i].date.getTime(), y: maValues[i] }));

        const datasets = [
            {
                label: '실제 환율',
                data: chartData1,
                borderColor: '#003b70',
                borderWidth: 2,
                fill: {
                    target: 5,
                    above: 'rgba(40, 167, 69, 0.15)',
                    below: 'rgba(220, 53, 69, 0.15)'
                },
                pointRadius: 0,
                pointHoverRadius: 4,
                tension: 0.1
            },
            {
                label: 'MA5 (5일)',
                data: makeMaData(sma5),
                borderColor: '#ff6384',
                borderWidth: 1,
                fill: false,
                pointRadius: 0,
                tension: 0.1,
                hidden: true
            },
            {
                label: 'MA20 (20일)',
                data: makeMaData(sma20),
                borderColor: '#9966ff',
                borderWidth: 1.2,
                fill: false,
                pointRadius: 0,
                tension: 0.1
            },
            {
                label: 'MA60 (60일)',
                data: makeMaData(sma60),
                borderColor: '#ff9f40',
                borderWidth: 1.5,
                fill: false,
                pointRadius: 0,
                tension: 0.1
            },
            {
                label: 'MA120 (120일)',
                data: makeMaData(sma120),
                borderColor: '#4bc0c0',
                borderWidth: 1.5,
                fill: false,
                pointRadius: 0,
                tension: 0.1
            },
            {
                label: '누적 평균 매입 환율',
                data: chartData2,
                borderColor: '#28a745',
                borderWidth: 2,
                borderDash: [5, 5],
                fill: false,
                pointRadius: 0,
                pointHoverRadius: 4,
                tension: 0.1
            }
        ];

        const scales = {
            x: {
                type: 'linear',
                position: 'bottom',
                title: { display: true, text: '날짜' },
                ticks: {
                    callback: this._formatChartDate,
                    maxTicksLimit: 12
                }
            },
            y: {
                title: { display: true, text: '환율 (원/달러)' }
            }
        };

        // 적립액 추이 (원화고정납입 모드)
        if (result.useDollarPremiumMode && result.reserveHistory.length > 0) {
            datasets.push({
                label: '적립액 ($)',
                data: result.reserveHistory.map(h => ({ x: h.date.getTime(), y: h.balance })),
                borderColor: '#ffc107',
                backgroundColor: 'rgba(255, 193, 7, 0.08)',
                borderWidth: 2,
                fill: true,
                pointRadius: 0,
                pointHoverRadius: 4,
                tension: 0.1,
                yAxisID: 'y2'
            });
            scales.y2 = {
                type: 'linear',
                position: 'right',
                title: { display: true, text: '적립액 ($)' },
                grid: { drawOnChartArea: false }
            };
        }

        // 추가납입 누적 ($)
        if (result.additionalHistory && result.additionalHistory.length > 0) {
            datasets.push({
                label: '추가납입 누적 ($)',
                data: result.additionalHistory.map(h => ({ x: h.date.getTime(), y: h.cumulative })),
                borderColor: '#005a9e',
                borderWidth: 2,
                borderDash: [3, 3],
                fill: false,
                pointRadius: 0,
                pointHoverRadius: 4,
                tension: 0.1,
                yAxisID: 'y2'
            });
            if (!scales.y2) {
                scales.y2 = {
                    type: 'linear',
                    position: 'right',
                    title: { display: true, text: '적립액 / 추가납입 ($)' },
                    grid: { drawOnChartArea: false }
                };
            }
        }

        // 이벤트 마커 (3% 이상 변동)
        const events = [];
        for (let i = 1; i < sampledData.length; i++) {
            const change = (sampledData[i].rate - sampledData[i-1].rate) / sampledData[i-1].rate;
            if (Math.abs(change) >= 0.03) {
                events.push({
                    x: sampledData[i].date.getTime(),
                    y: sampledData[i].rate,
                    change
                });
            }
        }
        if (events.length > 0 && events.length < 50) {
            datasets.push({
                label: '급등락 이벤트',
                data: events.map(e => ({ x: e.x, y: e.y })),
                type: 'scatter',
                pointRadius: 6,
                pointBackgroundColor: events.map(e => e.change > 0 ? 'rgba(220,53,69,0.7)' : 'rgba(40,167,69,0.7)'),
                pointBorderColor: events.map(e => e.change > 0 ? '#dc3545' : '#28a745'),
                pointBorderWidth: 2,
                showLine: false
            });
        }

        // 오늘 라인 + 손익 영역 플러그인
        const todayTs = new Date().getTime();
        const customPlugins = [{
            id: 'todayLine',
            afterDraw(chart) {
                const xScale = chart.scales.x;
                const yScale = chart.scales.y;
                const px = xScale.getPixelForValue(todayTs);
                if (px >= xScale.left && px <= xScale.right) {
                    const ctx = chart.ctx;
                    ctx.save();
                    ctx.strokeStyle = '#dc3545';
                    ctx.lineWidth = 1.5;
                    ctx.setLineDash([4, 4]);
                    ctx.beginPath();
                    ctx.moveTo(px, yScale.top);
                    ctx.lineTo(px, yScale.bottom);
                    ctx.stroke();
                    ctx.fillStyle = '#dc3545';
                    ctx.font = '11px sans-serif';
                    ctx.fillText('오늘', px + 4, yScale.top + 14);
                    ctx.restore();
                }
            }
        }];

        this.chart = new Chart(ctx, {
            type: 'line',
            data: { datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    title: { display: true, text: '환율 추이 · 이동평균선 · 누적 매입 평균' },
                    legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 } } },
                    tooltip: {
                        callbacks: {
                            title: function(items) {
                                if (items.length > 0) {
                                    const d = new Date(items[0].parsed.x);
                                    return d.getFullYear() + '년 ' + (d.getMonth()+1) + '월 ' + d.getDate() + '일';
                                }
                            }
                        }
                    }
                },
                scales,
                interaction: { intersect: false, mode: 'index' }
            },
            plugins: customPlugins
        });

        // MACD 차트
        const macdData = this.calculateMACD(rates);
        this.renderMACDChart(allData, sampledIndices, macdData);
    }

    renderMACDChart(allData, sampledIndices, macdData) {
        const canvas = document.getElementById('macdChart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        const makeSampledData = (values) => sampledIndices
            .filter(i => values[i] !== null)
            .map(i => ({ x: allData[i].date.getTime(), y: values[i] }));

        const histogramData = makeSampledData(macdData.histogram);

        this.macdChart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [
                    {
                        label: 'MACD 히스토그램',
                        data: histogramData,
                        borderWidth: 1.5,
                        fill: 'origin',
                        pointRadius: 0,
                        tension: 0,
                        segment: {
                            borderColor: (ctx) => ctx.p1.parsed.y >= 0 ? '#28a745' : '#dc3545',
                            backgroundColor: (ctx) => ctx.p1.parsed.y >= 0 ? 'rgba(40,167,69,0.3)' : 'rgba(220,53,69,0.3)'
                        },
                        borderColor: '#999',
                        backgroundColor: 'rgba(0,0,0,0.1)',
                        order: 2
                    },
                    {
                        label: 'MACD (12,26)',
                        data: makeSampledData(macdData.macdLine),
                        borderColor: '#003b70',
                        borderWidth: 1.5,
                        fill: false,
                        pointRadius: 0,
                        tension: 0.1,
                        order: 1
                    },
                    {
                        label: 'Signal (9)',
                        data: makeSampledData(macdData.signal),
                        borderColor: '#ff6384',
                        borderWidth: 1.5,
                        borderDash: [3, 3],
                        fill: false,
                        pointRadius: 0,
                        tension: 0.1,
                        order: 1
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    title: { display: true, text: 'MACD (12, 26, 9)' },
                    legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 } } },
                    tooltip: {
                        callbacks: {
                            title: function(items) {
                                if (items.length > 0) {
                                    const d = new Date(items[0].parsed.x);
                                    return d.getFullYear() + '년 ' + (d.getMonth()+1) + '월 ' + d.getDate() + '일';
                                }
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'linear',
                        position: 'bottom',
                        ticks: {
                            callback: this._formatChartDate,
                            maxTicksLimit: 12
                        }
                    },
                    y: {
                        title: { display: true, text: 'MACD' },
                        grid: {
                            color: (context) => context.tick.value === 0 ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.1)'
                        }
                    }
                },
                interaction: { intersect: false, mode: 'index' }
            }
        });
    }

    updatePriceMetrics(result) {
        const el = document.getElementById('priceMetrics');
        el.innerHTML = `
            <div class="metric-card metric-card--investment">
                <div class="metric-label">만기 시점 환율</div>
                <div class="metric-value">${result.finalRate.toFixed(2)}원</div>
            </div>
            <div class="metric-card metric-card--rate">
                <div class="metric-label">최종 평균 매입 환율</div>
                <div class="metric-value">${result.finalAveragePrice.toFixed(2)}원</div>
            </div>
            <div class="metric-card metric-card--profit">
                <div class="metric-label">환율 위치</div>
                <div class="metric-value">${this.getGaugeText(result)}</div>
            </div>
        `;
        // 게이지 업데이트
        this.updateGauge(result);
    }

    getGaugeText(result) {
        const rates = result.allData.map(d => d.rate).sort((a,b) => a-b);
        const current = result.finalRate;
        const rank = rates.filter(r => r <= current).length;
        const pct = (rank / rates.length * 100).toFixed(0);
        return `상위 ${100 - pct}%`;
    }

    // ========================
    // Phase 5-3: 환율 게이지
    // ========================
    updateGauge(result) {
        const gaugeEl = document.getElementById('rateGauge');
        if (!gaugeEl) return;
        const rates = result.allData.map(d => d.rate);
        const minRate = Math.min(...rates);
        const maxRate = Math.max(...rates);
        const current = result.finalRate;
        const avg = result.finalAveragePrice;
        const range = maxRate - minRate || 1;
        const currentPct = ((current - minRate) / range * 100).toFixed(1);
        const avgPct = ((avg - minRate) / range * 100).toFixed(1);

        gaugeEl.innerHTML = `
            <div class="gauge-labels">
                <span>${Math.round(minRate)}원</span>
                <span style="font-weight:600">현재 ${Math.round(current)}원 | 평균매입 ${Math.round(avg)}원</span>
                <span>${Math.round(maxRate)}원</span>
            </div>
            <div class="gauge-track">
                <div class="gauge-fill-low" style="width:${Math.min(currentPct, avgPct)}%"></div>
                <div class="gauge-marker gauge-marker-avg" style="left:${avgPct}%" title="평균매입 ${Math.round(avg)}원">▼</div>
                <div class="gauge-marker gauge-marker-current" style="left:${currentPct}%" title="현재 ${Math.round(current)}원">▲</div>
            </div>
        `;
    }

    updatePeriodInfo() {
        const cfg = this.getConfig();
        const conv = cfg.totalPeriodYears - (cfg.purchasePeriodYears + cfg.holdingPeriodYears);
        document.getElementById('periodInfo').textContent =
            `납입기간 ${cfg.purchasePeriodYears}년 | 거치기간 ${cfg.holdingPeriodYears}년 | 저축전환 ${conv.toFixed(1)}년 | 보험기간 ${cfg.totalPeriodYears}년`;
    }

    // ========================
    // Phase 2-4: 납입 스케줄 탭
    // ========================
    updateScheduleTab(result) {
        const tbody = document.getElementById('scheduleTableBody');
        if (!tbody) return;
        let html = '';
        result.reserveHistory.forEach((h, i) => {
            const rowClass = h.action === 'deposit' ? 'deposit' : h.action === 'withdraw' ? 'withdraw' : 'depleted';
            const actionText = h.action === 'deposit' ? `+$${h.actionAmount.toFixed(2)}`
                : h.action === 'withdraw' ? `-$${h.actionAmount.toFixed(2)}`
                : h.action === 'none' ? '-'
                : `추가 +${Math.round(h.extraKrw || 0).toLocaleString()}원`;
            const diff = h.krwPaid !== undefined ? h.krwPaid - h.krwEquivalent : 0;
            html += `<tr class="${rowClass}">
                <td>${i + 1}</td>
                <td>${h.date.toISOString().split('T')[0]}</td>
                <td>${h.rate.toFixed(2)}</td>
                <td>${Math.round(h.krwPaid || 0).toLocaleString()}</td>
                <td>$${h.dollarPremium}</td>
                <td>${Math.round(h.krwEquivalent).toLocaleString()}</td>
                <td class="${diff >= 0 ? 'positive' : 'negative'}">${diff >= 0 ? '+' : ''}${Math.round(diff).toLocaleString()}</td>
                <td>${actionText}</td>
                <td>$${h.balance.toFixed(2)}</td>
            </tr>`;
        });
        tbody.innerHTML = html;

        // 추가납입 스케줄
        const additionalSection = document.getElementById('additionalScheduleSection');
        if (result.additionalHistory.length > 0) {
            let addHtml = `
            <hr style="margin: 20px 0; border-color: #e9ecef;">
            <h3 style="color: #003b70; margin-bottom: 15px;">저축전환 후 추가납입 스케줄</h3>
            <div class="schedule-wrapper">
                <table class="schedule-table">
                    <thead><tr>
                        <th>회차</th><th>납입일</th><th>환율</th><th>추가납입($)</th>
                        <th>원화환산</th><th>만기시 가치($)</th><th>누적($)</th>
                    </tr></thead><tbody>`;
            result.additionalHistory.forEach((h, i) => {
                addHtml += `<tr class="additional">
                    <td>${i + 1}</td>
                    <td>${h.date.toISOString().split('T')[0]}</td>
                    <td>${h.rate.toFixed(2)}</td>
                    <td>$${h.premium.toFixed(2)}</td>
                    <td>${Math.round(h.krwPaid).toLocaleString()}</td>
                    <td>$${h.compounded.toFixed(2)}</td>
                    <td>$${h.cumulative.toFixed(2)}</td>
                </tr>`;
            });
            addHtml += '</tbody></table></div>';

            if (additionalSection) {
                additionalSection.innerHTML = addHtml;
                additionalSection.style.display = 'block';
            }
        } else {
            if (additionalSection) additionalSection.style.display = 'none';
        }
    }

    // ========================
    // Phase 4-1: 목표 역산 (카드형) + Phase 4-2: 시나리오 비교 테이블
    // ========================
    async calculateTarget() {
        const targetValue = parseInt(document.getElementById('targetValue').value);
        const resultDiv = document.getElementById('targetResult');
        const scenarioDiv = document.getElementById('scenarioResult');
        resultDiv.innerHTML = '<div class="loading"><div class="spinner"></div>계산 중...</div>';
        if (scenarioDiv) scenarioDiv.innerHTML = '';

        try {
            const currentSim = this.runSimulation();
            const currentPremium = currentSim.config.dollarPremium;
            const currentFinal = currentSim.finalValue;
            const achievePct = Math.min((currentFinal / targetValue) * 100, 999);
            const isAchieved = currentFinal >= targetValue;

            // dollarPremium($)을 역산
            let low = 10, high = 50000, mid, finalVal, sim;
            for (let i = 0; i < 30; i++) {
                mid = (low + high) / 2;
                sim = this.runSimulation({ dollarPremium: mid });
                finalVal = sim.finalValue;
                if (Math.abs(finalVal - targetValue) < 1000) break;
                if (finalVal < targetValue) low = mid; else high = mid;
            }
            const diff = mid - currentPremium;
            const requiredPremium = Math.round(mid);

            // 4-1: 역산 결과 카드형 시각화
            resultDiv.innerHTML = `
                <div class="target-comparison">
                    <div class="target-comparison-header">
                        <div class="target-comparison-title">목표: ${targetValue.toLocaleString()}원</div>
                        <div class="target-progress-bar">
                            <div class="target-progress-fill ${isAchieved ? 'achieved' : ''}" style="width: ${Math.min(achievePct, 100)}%"></div>
                            <span class="target-progress-label">${achievePct.toFixed(1)}%</span>
                        </div>
                    </div>
                    <div class="target-vs-grid">
                        <div class="target-vs-card current">
                            <div class="target-vs-badge">현재 설정</div>
                            <div class="target-vs-premium">$${currentPremium.toLocaleString()}<small>/월</small></div>
                            <div class="target-vs-krw">${Math.round(currentSim.fixedKrw).toLocaleString()}원/월</div>
                            <div class="target-vs-result ${isAchieved ? 'positive' : 'negative'}">
                                → ${Math.round(currentFinal).toLocaleString()}원
                            </div>
                            <div class="target-vs-gap">${isAchieved ? '목표 달성' : `${Math.round(targetValue - currentFinal).toLocaleString()}원 부족`}</div>
                        </div>
                        <div class="target-vs-arrow">${isAchieved ? '✓' : '→'}</div>
                        <div class="target-vs-card required ${isAchieved ? 'achieved' : ''}">
                            <div class="target-vs-badge">필요 설정</div>
                            <div class="target-vs-premium">$${requiredPremium.toLocaleString()}<small>/월</small></div>
                            <div class="target-vs-krw">${Math.round(sim.fixedKrw).toLocaleString()}원/월</div>
                            <div class="target-vs-result positive">
                                → ${Math.round(finalVal).toLocaleString()}원
                            </div>
                            <div class="target-vs-gap">
                                ${diff >= 0 ? '+' : ''}$${Math.round(diff).toLocaleString()}/월
                                (${diff >= 0 ? '+' : ''}${Math.round(diff * currentSim.finalRate).toLocaleString()}원)
                            </div>
                        </div>
                    </div>
                </div>`;

            // 4-2: 다중 시나리오 비교 테이블
            if (scenarioDiv) {
                const scenarios = [
                    { name: '표준', interestRate: currentSim.config.interestRate, compoundRate: currentSim.config.compoundRate },
                ];
                // 각 시나리오별 역산
                const scenarioResults = scenarios.map(s => {
                    // 임시로 DOM 값을 변경해서 시뮬레이션
                    const origInterest = document.getElementById('interestRate').value;
                    const origCompound = document.getElementById('compoundRate').value;
                    document.getElementById('interestRate').value = s.interestRate;
                    document.getElementById('compoundRate').value = s.compoundRate;

                    // 현재 보험료로 시뮬
                    const currentResult = this.runSimulation();

                    // 목표 역산
                    let lo = 10, hi = 50000, m, fv, rs;
                    for (let i = 0; i < 30; i++) {
                        m = (lo + hi) / 2;
                        rs = this.runSimulation({ dollarPremium: m });
                        fv = rs.finalValue;
                        if (Math.abs(fv - targetValue) < 1000) break;
                        if (fv < targetValue) lo = m; else hi = m;
                    }

                    // DOM 복원
                    document.getElementById('interestRate').value = origInterest;
                    document.getElementById('compoundRate').value = origCompound;

                    return {
                        ...s,
                        currentFinal: currentResult.finalValue,
                        requiredPremium: Math.round(m),
                        requiredKrw: Math.round(rs.fixedKrw),
                        achievedValue: Math.round(fv)
                    };
                });

                const isCurrentScenario = (s) =>
                    s.interestRate === currentSim.config.interestRate && s.compoundRate === currentSim.config.compoundRate;

                scenarioDiv.innerHTML = `
                    <h3 style="margin-bottom: 12px;">이율 시나리오별 비교</h3>
                    <p class="small-text" style="margin-bottom: 12px;">동일 목표(${targetValue.toLocaleString()}원) 달성을 위해 이율 조건별 필요 납입액 비교</p>
                    <div class="scenario-table-wrap">
                        <table class="scenario-compare-table">
                            <thead>
                                <tr>
                                    <th>시나리오</th>
                                    <th>약정이율</th>
                                    <th>공시이율</th>
                                    <th>현재보험료 만기가치</th>
                                    <th>필요 보험료</th>
                                    <th>필요 원화납입</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${scenarioResults.map(s => `
                                    <tr class="${isCurrentScenario(s) ? 'scenario-current' : ''}">
                                        <td><strong>${s.name}</strong>${isCurrentScenario(s) ? ' <span class="scenario-badge">현재</span>' : ''}</td>
                                        <td>${s.interestRate}%</td>
                                        <td>${s.compoundRate}%</td>
                                        <td class="${s.currentFinal >= targetValue ? 'positive' : 'negative'}">${Math.round(s.currentFinal).toLocaleString()}원</td>
                                        <td><strong>$${s.requiredPremium.toLocaleString()}</strong>/월</td>
                                        <td>${s.requiredKrw.toLocaleString()}원/월</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>`;
            }
        } catch (e) {
            resultDiv.innerHTML = '<div class="error">계산 중 오류가 발생했습니다.</div>';
            console.error('목표 역산 오류:', e);
        }
    }

    // ========================
    // 차트 전체화면
    // ========================
    toggleFullscreen(chartId) {
        const canvas = document.getElementById(chartId);
        const container = canvas.parentElement;
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            container.requestFullscreen();
        }
    }

    // ========================
    // Phase 5-2: 내보내기
    // ========================
    exportAsImage() {
        const canvas = document.getElementById('priceChart');
        const link = document.createElement('a');
        link.download = `달러종신보험_시뮬레이션_${new Date().toISOString().split('T')[0]}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
    }

    exportAsCSV() {
        const tbody = document.getElementById('scheduleTableBody');
        if (!tbody || !tbody.rows.length) { alert('스케줄 데이터가 없습니다.'); return; }
        let csv = '\uFEFF회차,납입일,환율,원화납입보험료,보험료(USD),원화환산액,차액,적립/인출,적립금(USD)\n';
        for (const row of tbody.rows) {
            const cells = Array.from(row.cells).map(c => c.textContent.replace(/,/g, ''));
            csv += cells.join(',') + '\n';
        }
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.download = `납입스케줄_${new Date().toISOString().split('T')[0]}.csv`;
        link.href = URL.createObjectURL(blob);
        link.click();
    }

    // ========================
    // 설정 저장/불러오기
    // ========================
    downloadConfig() {
        const config = this.getConfig();
        config.customerName = document.getElementById('customerName')?.value || '';
        const customerName = config.customerName || '설정';
        const dateStr = new Date().toISOString().split('T')[0];
        const blob = new Blob([JSON.stringify(config, null, 4)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `시뮬레이션_${customerName}_${dateStr}.json`;
        link.click();
    }

    shareAsUrl() {
        const config = this.getConfig();
        const customerName = document.getElementById('customerName')?.value || '';
        const params = new URLSearchParams();
        params.set('key', this.PASSWORD);
        if (customerName) params.set('name', customerName);
        // 핵심 설정만 URL에 포함 (짧게 유지)
        const shortKeys = {
            totalPeriodYears: 'tp', dollarPremium: 'dp', fixedPaymentMultiplier: 'fm',
            purchasePeriodYears: 'pp', holdingPeriodYears: 'hp',
            interestRate: 'ir', compoundRate: 'cr', reserveInterestRate: 'ri',
            additionalBudget: 'ab', additionalStrategy: 'as', additionalEnabled: 'ae',
            insuredAmount: 'ia', interval: 'iv'
        };
        for (const [full, short] of Object.entries(shortKeys)) {
            const val = config[full];
            if (val !== undefined && val !== null && val !== '') {
                params.set(short, val);
            }
        }
        const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
        navigator.clipboard.writeText(url).then(() => {
            this.showToast('공유 링크가 클립보드에 복사되었습니다');
        }).catch(() => {
            prompt('아래 링크를 복사하세요:', url);
        });
    }

    loadFromUrlParams() {
        const params = new URLSearchParams(window.location.search);
        if (params.size < 2) return; // key만 있으면 기본 설정 유지
        const shortKeys = {
            tp: 'timeRange', dp: 'dollarPremium', fm: 'fixedPaymentMultiplier',
            pp: 'purchasePeriod', hp: 'holdingPeriod',
            ir: 'interestRate', cr: 'compoundRate', ri: 'reserveInterestRate',
            ab: 'additionalBudget', as: 'additionalStrategy',
            ia: 'insuredAmount', iv: 'interval'
        };
        for (const [short, elemId] of Object.entries(shortKeys)) {
            const val = params.get(short);
            if (val !== null) {
                const el = document.getElementById(elemId);
                if (el) el.value = val;
            }
        }
        // additionalEnabled 체크박스 복원
        const ae = params.get('ae');
        if (ae !== null) {
            const cb = document.getElementById('additionalEnabled');
            if (cb) cb.checked = (ae === 'true' || ae === '1');
        }
        const name = params.get('name');
        if (name) {
            const nameEl = document.getElementById('customerName');
            if (nameEl) nameEl.value = name;
        }
        this.toggleDollarPremiumFields();
    }

    async exportPdf() {
        if (typeof html2canvas === 'undefined' || typeof jspdf === 'undefined') {
            this.showToast('PDF 라이브러리를 로딩 중입니다. 잠시 후 다시 시도해 주세요.');
            return;
        }
        this.showToast('PDF 생성 중...');
        try {
            const { jsPDF } = jspdf;
            const pdf = new jsPDF('p', 'mm', 'a4');
            const pageW = 210, margin = 10, contentW = pageW - margin * 2;
            let y = margin;

            // 제목
            const customerName = document.getElementById('customerName')?.value || '';
            pdf.setFontSize(18);
            pdf.setFont(undefined, 'bold');
            pdf.text(`달러종신보험 시뮬레이션 리포트`, margin, y + 8);
            y += 14;
            if (customerName) {
                pdf.setFontSize(13);
                pdf.text(`${customerName} 고객님`, margin, y);
                y += 8;
            }
            pdf.setFontSize(9);
            pdf.setFont(undefined, 'normal');
            pdf.text(`생성일: ${new Date().toLocaleDateString('ko-KR')}`, margin, y);
            y += 10;

            // 결과 탭 캡처
            const resultsTab = document.getElementById('resultsTab');
            if (resultsTab) {
                const canvas = await html2canvas(resultsTab, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
                const imgData = canvas.toDataURL('image/jpeg', 0.85);
                const imgH = (canvas.height / canvas.width) * contentW;
                const maxH = 280 - y;
                const finalH = Math.min(imgH, maxH);
                pdf.addImage(imgData, 'JPEG', margin, y, contentW, finalH);
                y += finalH + 5;
            }

            // 차트 캡처 (새 페이지)
            const chartCanvas = document.getElementById('priceChart');
            if (chartCanvas) {
                pdf.addPage();
                y = margin;
                pdf.setFontSize(14);
                pdf.setFont(undefined, 'bold');
                pdf.text('환율 추이 차트', margin, y + 6);
                y += 12;
                const imgData = chartCanvas.toDataURL('image/jpeg', 0.9);
                const imgH = (chartCanvas.height / chartCanvas.width) * contentW;
                pdf.addImage(imgData, 'JPEG', margin, y, contentW, Math.min(imgH, 120));
            }

            // 면책 문구
            pdf.setFontSize(8);
            pdf.setFont(undefined, 'normal');
            pdf.setTextColor(150);
            pdf.text('* 본 시뮬레이션은 과거 데이터 기반 참고용이며, 실제 수익을 보장하지 않습니다.', margin, 285);

            const fileName = customerName ? `시뮬레이션_${customerName}.pdf` : '시뮬레이션_리포트.pdf';
            pdf.save(fileName);
            this.showToast('PDF가 저장되었습니다');
        } catch (e) {
            this.showToast('PDF 생성 중 오류가 발생했습니다');
        }
    }

    async exportResultImage() {
        if (typeof html2canvas === 'undefined') {
            this.showToast('이미지 라이브러리를 로딩 중입니다. 잠시 후 다시 시도해 주세요.');
            return;
        }
        const resultsTab = document.getElementById('resultsTab');
        if (!resultsTab) return;
        this.showToast('이미지 생성 중...');
        try {
            const canvas = await html2canvas(resultsTab, { scale: 2, backgroundColor: '#ffffff' });
            const link = document.createElement('a');
            const customerName = document.getElementById('customerName')?.value || '결과';
            link.download = `시뮬레이션_${customerName}.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();
            this.showToast('이미지가 저장되었습니다');
        } catch (e) {
            this.showToast('이미지 생성 중 오류가 발생했습니다');
        }
    }

    showToast(message) {
        const toast = document.createElement('div');
        toast.textContent = message;
        Object.assign(toast.style, {
            position: 'fixed', bottom: '80px', left: '50%', transform: 'translateX(-50%)',
            background: 'var(--color-primary-800)', color: 'white', padding: '12px 24px',
            borderRadius: 'var(--radius-full)', fontSize: '0.9em', fontWeight: '600',
            boxShadow: 'var(--shadow-lg)', zIndex: '10000', animation: 'fadeInUp 0.3s ease-out',
            fontFamily: 'inherit'
        });
        document.body.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; }, 2000);
        setTimeout(() => toast.remove(), 2500);
    }

    uploadConfig(event) {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const config = JSON.parse(e.target.result);
                this.applyConfig(config);
                this.updateSimulation();
            } catch (err) {
                alert('설정 파일 오류: ' + err.message);
            }
        };
        reader.readAsText(file);
    }

    applyConfig(config) {
        const map = {
            totalPeriodYears: 'timeRange', interval: 'interval', endDate: 'endDate',
            purchasePeriodYears: 'purchasePeriod',
            holdingPeriodYears: 'holdingPeriod', interestRate: 'interestRate',
            compoundRate: 'compoundRate', dollarPremium: 'dollarPremium',
            fixedPaymentMultiplier: 'fixedPaymentMultiplier',
            reserveInterestRate: 'reserveInterestRate',
            additionalBudget: 'additionalBudget',
            additionalStrategy: 'additionalStrategy',
            additionalPremiumLimitPct: 'additionalPremiumLimitPct',
            insuredAmount: 'insuredAmount',
            enrollmentType: 'enrollmentType',
            maintenanceBonus1: 'maintenanceBonus1',
            maintenanceBonus2: 'maintenanceBonus2'
        };
        for (const [key, id] of Object.entries(map)) {
            if (config[key] !== undefined) {
                const el = document.getElementById(id);
                if (el) el.value = config[key];
            }
        }
        this.updateEnrollmentTypeDesc();
        this.toggleDollarPremiumFields();
    }

    updateEnrollmentTypeDesc() {
        const desc = document.getElementById('enrollmentTypeDesc');
        if (!desc) return;
        const type = document.getElementById('enrollmentType')?.value || 'simple';
        if (type === 'simple') {
            desc.textContent = '* 매년 5%씩 체증, 최대 150% (10년)';
        } else {
            desc.textContent = '* 매년 5%씩 체증, 최대 200% (20년)';
        }
    }

    // ========================
    // Phase 5-1: 모바일 사이드바
    // ========================
    toggleSidebar() {
        const sidebar = document.querySelector('.sidebar');
        const overlay = document.getElementById('sidebarOverlay');
        sidebar.classList.toggle('open');
        if (overlay) overlay.classList.toggle('active');
    }

    // ========================
    // 은행 비교 탭 렌더링
    // ========================
    updateComparisonTab(insuranceResult) {
        if (!insuranceResult) return;
        const bank = this.runBankSimulation(insuranceResult);
        const etf = this.runEtfSimulation(insuranceResult);
        this.renderComparisonSummary(insuranceResult, bank, etf);
        this.renderComparisonChart(insuranceResult, bank, etf);
        this.renderComparisonTable(insuranceResult, bank, etf);
    }

    renderComparisonSummary(ins, bank, etf) {
        const el = document.getElementById('comparisonSummary');
        if (!el) return;

        const fmt = v => Math.round(v).toLocaleString('ko-KR');
        const fmtUsd = v => v.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        // 3종 중 우위 판별
        const values = [
            { name: '은행', krw: bank.finalKrw, icon: '🏦' },
            { name: 'ETF', krw: etf.finalKrw, icon: '📈' },
            { name: '보험', krw: ins.finalValue, icon: '🛡️' }
        ];
        values.sort((a, b) => b.krw - a.krw);
        const winner = values[0];
        const second = values[1];
        const winDiff = winner.krw - second.krw;

        const accountLabel = { general: '일반', isa: 'ISA', pension: '연금저축' };

        el.innerHTML = `
            <div class="comparison-card comparison-card--bank">
                <h3>🏦 은행 달러 예금</h3>
                <div class="big-value">${fmt(bank.finalKrw)}원</div>
                <div class="sub-value">$${fmtUsd(bank.finalUsd)} × ${fmt(bank.finalRate)}원</div>
                <span class="profit-badge ${bank.profitRate >= 0 ? 'profit-badge--positive' : 'profit-badge--negative'}">
                    ${bank.profitRate >= 0 ? '+' : ''}${bank.profitRate.toFixed(1)}%
                </span>
                <div class="sub-value" style="margin-top:8px;">
                    세금(이자소득세): -$${fmtUsd(bank.tax)}
                </div>
            </div>
            <div class="comparison-card comparison-card--etf">
                <h3>📈 달러채권 ETF</h3>
                <div class="big-value" style="color: #7c3aed;">${fmt(etf.finalKrw)}원</div>
                <div class="sub-value">$${fmtUsd(etf.finalUsd)} × ${fmt(etf.finalRate)}원</div>
                <span class="profit-badge ${etf.profitRate >= 0 ? 'profit-badge--positive' : 'profit-badge--negative'}">
                    ${etf.profitRate >= 0 ? '+' : ''}${etf.profitRate.toFixed(1)}%
                </span>
                <div class="sub-value" style="margin-top:8px;">
                    세금(${accountLabel[etf.accountType] || '일반'}): -$${fmtUsd(etf.tax)}
                </div>
            </div>
            <div class="comparison-card comparison-card--insurance">
                <h3>🛡️ 달러종신보험</h3>
                <div class="big-value" style="color: var(--color-primary-700);">${fmt(ins.finalValue)}원</div>
                <div class="sub-value">$${fmtUsd(ins.totalUnits + (ins.additionalTotalCompounded || 0))} × ${fmt(ins.finalRate)}원</div>
                <span class="profit-badge ${ins.profitRate >= 0 ? 'profit-badge--positive' : 'profit-badge--negative'}">
                    ${ins.profitRate >= 0 ? '+' : ''}${ins.profitRate.toFixed(1)}%
                </span>
                <div class="sub-value" style="margin-top:8px;">
                    세금: 비과세 (10년 유지)
                </div>
                ${ins.config.insuredAmount > 0 ? (() => {
                    const db = this._getDeathBenefitStatus(ins);
                    if (db.afterConversion) {
                        return `<div class="sub-value" style="margin-top:8px; color: #999;">사망보험금: 전환 후 소멸</div>`;
                    }
                    return `<div class="sub-value" style="margin-top:8px; color: #ef4444; font-weight:600;">사망보험금: $${Math.round(db.maxBenefit).toLocaleString()}</div>`;
                })() : ''}
            </div>
            <div class="comparison-card comparison-card--result">
                <h3>${winner.icon} ${winner.name} 우위</h3>
                <div class="big-value" style="color: #059669;">
                    +${fmt(winDiff)}원
                </div>
                <div class="sub-value">
                    2위(${second.name}) 대비
                </div>
                <div class="sub-value" style="margin-top:12px; font-size:0.82em; line-height:1.5;">
                    은행 ${bank.profitRate >= 0 ? '+' : ''}${bank.profitRate.toFixed(1)}% · ETF ${etf.profitRate >= 0 ? '+' : ''}${etf.profitRate.toFixed(1)}% · 보험 ${ins.profitRate >= 0 ? '+' : ''}${ins.profitRate.toFixed(1)}%
                </div>
            </div>
        `;
    }

    renderComparisonChart(ins, bank, etf) {
        const canvas = document.getElementById('comparisonChart');
        if (!canvas) return;

        if (this.comparisonChart) {
            this.comparisonChart.destroy();
            this.comparisonChart = null;
        }

        // 은행 시계열: 잔액 × 당시 환율 = 원화 가치
        const bankData = bank.bankHistory.map(h => ({
            x: h.date.getTime(),
            y: h.balance * h.rate
        }));

        // ETF 시계열: 잔액 × 당시 환율
        const etfData = etf.etfHistory.map(h => ({
            x: h.date.getTime(),
            y: h.balance * h.rate
        }));

        // 보험 시계열: 납입기간 중 누적 달러 × 당시 환율
        const insData = [];
        let cumDollar = 0;
        let reserve = 0;
        for (const h of ins.reserveHistory) {
            cumDollar += h.dollarPremium;
            reserve = h.balance;
            insData.push({
                x: h.date.getTime(),
                y: (cumDollar + reserve) * h.rate
            });
        }

        // 거치기간 끝: 약정이자 포함
        if (ins.holdingEndDate && ins.totalBeforeConversion) {
            const holdRate = this.findClosestRate(ins.holdingEndDate);
            insData.push({
                x: ins.holdingEndDate.getTime(),
                y: ins.totalBeforeConversion * holdRate
            });
        }

        // 전환기간: 추가납입 포함 성장
        if (ins.additionalHistory && ins.additionalHistory.length > 0) {
            for (const ah of ins.additionalHistory) {
                const elapsed = (ah.date - ins.holdingEndDate) / (1000 * 60 * 60 * 24 * 365.25);
                const baseGrown = ins.totalBeforeConversion * Math.pow(1 + (ins.config.compoundRate / 100), elapsed);
                insData.push({
                    x: ah.date.getTime(),
                    y: (baseGrown + ah.cumulative) * ah.rate
                });
            }
        }

        // 만기 포인트
        if (ins.endDate) {
            insData.push({ x: ins.endDate.getTime(), y: ins.finalValue });
            const lastBank = bank.bankHistory[bank.bankHistory.length - 1];
            if (lastBank) {
                bankData.push({ x: ins.endDate.getTime(), y: bank.finalKrw });
            }
            const lastEtf = etf.etfHistory[etf.etfHistory.length - 1];
            if (lastEtf) {
                etfData.push({ x: ins.endDate.getTime(), y: etf.finalKrw });
            }
        }

        // 샘플링 (최대 500포인트)
        const sample = (data, max) => {
            if (data.length <= max) return data;
            const step = Math.ceil(data.length / max);
            const result = [];
            for (let i = 0; i < data.length; i += step) result.push(data[i]);
            if (result[result.length - 1] !== data[data.length - 1]) result.push(data[data.length - 1]);
            return result;
        };

        this.comparisonChart = new Chart(canvas, {
            type: 'line',
            data: {
                datasets: [
                    {
                        label: '🏦 은행 달러 예금',
                        data: sample(bankData, 500),
                        borderColor: '#10b981',
                        backgroundColor: 'rgba(16, 185, 129, 0.08)',
                        fill: true,
                        borderWidth: 2,
                        pointRadius: 0,
                        tension: 0.3,
                        order: 3
                    },
                    {
                        label: '📈 달러채권 ETF',
                        data: sample(etfData, 500),
                        borderColor: '#7c3aed',
                        backgroundColor: 'rgba(124, 58, 237, 0.08)',
                        fill: true,
                        borderWidth: 2,
                        pointRadius: 0,
                        tension: 0.3,
                        order: 2
                    },
                    {
                        label: '🛡️ 달러종신보험',
                        data: sample(insData, 500),
                        borderColor: '#003566',
                        backgroundColor: 'rgba(0, 53, 102, 0.08)',
                        fill: true,
                        borderWidth: 2,
                        pointRadius: 0,
                        tension: 0.3,
                        order: 1
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                aspectRatio: 2.5,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { position: 'top' },
                    tooltip: {
                        callbacks: {
                            title: ctx => {
                                const d = new Date(ctx[0].parsed.x);
                                return d.toLocaleDateString('ko-KR');
                            },
                            label: ctx => {
                                const v = Math.round(ctx.parsed.y).toLocaleString('ko-KR');
                                return `${ctx.dataset.label}: ${v}원`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'linear',
                        ticks: {
                            callback: v => new Date(v).getFullYear(),
                            maxTicksLimit: 10
                        }
                    },
                    y: {
                        ticks: {
                            callback: v => {
                                if (v >= 1e8) return (v / 1e8).toFixed(1) + '억';
                                if (v >= 1e4) return (v / 1e4).toFixed(0) + '만';
                                return v;
                            }
                        }
                    }
                }
            }
        });
    }

    renderComparisonTable(ins, bank, etf) {
        const container = document.getElementById('comparisonTableContainer');
        if (!container) return;

        const fmt = v => Math.round(v).toLocaleString('ko-KR');
        const fmtUsd = v => '$' + v.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const fmtPct = v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
        const fmtDate = d => d ? d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'short' }) : '-';

        // 보험 기간별 스냅샷 계산
        const insAtPayEnd = (() => {
            const totalDollar = ins.totalDollarPurchased + (ins.reserveAfterPayment || 0);
            const lastH = ins.reserveHistory[ins.reserveHistory.length - 1];
            const rate = lastH ? lastH.rate : ins.finalRate;
            const krwValue = totalDollar * rate;
            return { usd: totalDollar, krw: krwValue, rate, totalKrwPaid: ins.basicTotalInvestment };
        })();

        const insAtHoldEnd = (() => {
            if (!ins.holdingEndDate || ins.holdingEndDate <= ins.purchaseEndDate) return null;
            const rate = this.findClosestRate(ins.holdingEndDate);
            const usd = ins.totalBeforeConversion;
            return { usd, krw: usd * rate, rate, totalKrwPaid: ins.basicTotalInvestment };
        })();

        const insAtMaturity = {
            usd: ins.totalUnits + (ins.additionalTotalCompounded || 0),
            krw: ins.finalValue,
            rate: ins.finalRate,
            totalKrwPaid: ins.totalInvestment
        };

        // 은행/ETF 기간별 스냅샷
        const bankAtPayEnd = bank.atPaymentEnd;
        const bankAtHoldEnd = bank.atHoldingEnd;
        const etfAtPayEnd = etf.atPaymentEnd;
        const etfAtHoldEnd = etf.atHoldingEnd;

        const rows = [];

        // 납입 완료 시점
        if (bankAtPayEnd) {
            const insPct = insAtPayEnd.totalKrwPaid > 0 ? ((insAtPayEnd.krw - insAtPayEnd.totalKrwPaid) / insAtPayEnd.totalKrwPaid * 100) : 0;
            const bankPct = bankAtPayEnd.totalKrwPaid > 0 ? ((bankAtPayEnd.krwValue - bankAtPayEnd.totalKrwPaid) / bankAtPayEnd.totalKrwPaid * 100) : 0;
            const etfPct = etfAtPayEnd && etfAtPayEnd.totalKrwPaid > 0 ? ((etfAtPayEnd.krwValue - etfAtPayEnd.totalKrwPaid) / etfAtPayEnd.totalKrwPaid * 100) : 0;
            rows.push({
                label: `납입 완료 (${fmtDate(bankAtPayEnd.date)})`,
                bankUsd: fmtUsd(bankAtPayEnd.balance), bankKrw: fmt(bankAtPayEnd.krwValue) + '원', bankPct: fmtPct(bankPct),
                etfUsd: etfAtPayEnd ? fmtUsd(etfAtPayEnd.balance) : '-', etfKrw: etfAtPayEnd ? fmt(etfAtPayEnd.krwValue) + '원' : '-', etfPct: fmtPct(etfPct),
                insUsd: fmtUsd(insAtPayEnd.usd), insKrw: fmt(insAtPayEnd.krw) + '원', insPct: fmtPct(insPct)
            });
        }

        // 거치 완료 시점
        if (insAtHoldEnd && bankAtHoldEnd) {
            const insPct = insAtHoldEnd.totalKrwPaid > 0 ? ((insAtHoldEnd.krw - insAtHoldEnd.totalKrwPaid) / insAtHoldEnd.totalKrwPaid * 100) : 0;
            const bankPct = bankAtHoldEnd.totalKrwPaid > 0 ? ((bankAtHoldEnd.krwValue - bankAtHoldEnd.totalKrwPaid) / bankAtHoldEnd.totalKrwPaid * 100) : 0;
            const etfPct = etfAtHoldEnd && etfAtHoldEnd.totalKrwPaid > 0 ? ((etfAtHoldEnd.krwValue - etfAtHoldEnd.totalKrwPaid) / etfAtHoldEnd.totalKrwPaid * 100) : 0;
            rows.push({
                label: `거치 완료 (${fmtDate(bankAtHoldEnd.date)})`,
                bankUsd: fmtUsd(bankAtHoldEnd.balance), bankKrw: fmt(bankAtHoldEnd.krwValue) + '원', bankPct: fmtPct(bankPct),
                etfUsd: etfAtHoldEnd ? fmtUsd(etfAtHoldEnd.balance) : '-', etfKrw: etfAtHoldEnd ? fmt(etfAtHoldEnd.krwValue) + '원' : '-', etfPct: fmtPct(etfPct),
                insUsd: fmtUsd(insAtHoldEnd.usd), insKrw: fmt(insAtHoldEnd.krw) + '원', insPct: fmtPct(insPct)
            });
        }

        // 만기 시점
        {
            rows.push({
                label: `만기 (${fmtDate(ins.endDate)})`,
                bankUsd: fmtUsd(bank.finalUsd), bankKrw: fmt(bank.finalKrw) + '원', bankPct: fmtPct(bank.profitRate),
                etfUsd: fmtUsd(etf.finalUsd), etfKrw: fmt(etf.finalKrw) + '원', etfPct: fmtPct(etf.profitRate),
                insUsd: fmtUsd(insAtMaturity.usd), insKrw: fmt(insAtMaturity.krw) + '원', insPct: fmtPct(ins.profitRate)
            });
        }

        const accountLabels = { general: '일반 15.4%', isa: 'ISA 9.9%', pension: '연금저축 3.3~5.5%' };

        let html = `
        <div class="comparison-detail-section">
            <h3>기간별 비교</h3>
            <div class="comparison-table-wrap">
                <table class="comparison-table">
                    <thead>
                        <tr>
                            <th style="text-align:left;">시점</th>
                            <th class="bank-col">은행(USD)</th>
                            <th class="bank-col">은행(원화)</th>
                            <th class="bank-col">수익률</th>
                            <th class="etf-col">ETF(USD)</th>
                            <th class="etf-col">ETF(원화)</th>
                            <th class="etf-col">수익률</th>
                            <th class="ins-col">보험(USD)</th>
                            <th class="ins-col">보험(원화)</th>
                            <th class="ins-col">수익률</th>
                        </tr>
                    </thead>
                    <tbody>`;

        for (const row of rows) {
            html += `
                        <tr>
                            <td>${row.label}</td>
                            <td class="bank-col">${row.bankUsd}</td>
                            <td class="bank-col">${row.bankKrw}</td>
                            <td class="bank-col">${row.bankPct}</td>
                            <td class="etf-col">${row.etfUsd}</td>
                            <td class="etf-col">${row.etfKrw}</td>
                            <td class="etf-col">${row.etfPct}</td>
                            <td class="ins-col">${row.insUsd}</td>
                            <td class="ins-col">${row.insKrw}</td>
                            <td class="ins-col">${row.insPct}</td>
                        </tr>`;
        }

        html += `
                    </tbody>
                </table>
            </div>
        </div>

        <div class="comparison-detail-section">
            <h3>핵심 비교 요인</h3>
            <div class="comparison-table-wrap">
                <table class="comparison-table">
                    <thead>
                        <tr>
                            <th style="text-align:left;">항목</th>
                            <th class="bank-col">🏦 은행</th>
                            <th class="etf-col">📈 ETF</th>
                            <th class="ins-col">🛡️ 보험</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>환전 수수료</td>
                            <td class="bank-col">${(parseFloat(document.getElementById('bankExchangeFee')?.value) || 1.75).toFixed(2)}%</td>
                            <td class="etf-col">없음 (원화 매매)</td>
                            <td class="ins-col">없음 (보험사 자체 환전)</td>
                        </tr>
                        <tr>
                            <td>수익률 구조</td>
                            <td class="bank-col">USD 예금 ${(parseFloat(document.getElementById('bankInterestRate')?.value) || 0.1).toFixed(1)}%</td>
                            <td class="etf-col">채권 ${(parseFloat(document.getElementById('etfBondYield')?.value) || 4.0).toFixed(1)}% - 보수 ${(parseFloat(document.getElementById('etfExpenseRatio')?.value) || 0.25).toFixed(2)}%</td>
                            <td class="ins-col">부리 ${ins.config.reserveInterestRate}% → 약정 ${ins.config.interestRate}% → 공시 ${ins.config.compoundRate}%</td>
                        </tr>
                        <tr>
                            <td>세금</td>
                            <td class="bank-col">이자소득세 ${(parseFloat(document.getElementById('bankTaxRate')?.value) || 15.4).toFixed(1)}%</td>
                            <td class="etf-col">${accountLabels[etf.accountType] || '일반 15.4%'}</td>
                            <td class="ins-col">비과세 (10년 유지 시)</td>
                        </tr>
                        <tr>
                            <td>평균 매입 환율</td>
                            <td class="bank-col">${fmt(bank.averageRate)}원</td>
                            <td class="etf-col">${fmt(etf.averageRate)}원</td>
                            <td class="ins-col">${fmt(ins.finalAveragePrice)}원</td>
                        </tr>
                        <tr>
                            <td>총 납입 원화</td>
                            <td class="bank-col">${fmt(bank.totalKrwPaid)}원</td>
                            <td class="etf-col">${fmt(etf.totalKrwPaid)}원</td>
                            <td class="ins-col">${fmt(ins.totalInvestment)}원</td>
                        </tr>
                        <tr>
                            <td>최종 수익률</td>
                            <td class="bank-col ${bank.profitRate >= 0 ? 'diff-positive' : 'diff-negative'}">${fmtPct(bank.profitRate)}</td>
                            <td class="etf-col" style="font-weight:600; color: ${etf.profitRate >= 0 ? '#059669' : '#dc2626'}">${fmtPct(etf.profitRate)}</td>
                            <td class="ins-col ${ins.profitRate >= 0 ? 'diff-positive' : 'diff-negative'}">${fmtPct(ins.profitRate)}</td>
                        </tr>
                        ${ins.config.insuredAmount > 0 ? (() => {
                            const db = this._getDeathBenefitStatus(ins);
                            if (db.afterConversion) {
                                return `<tr style="background: rgba(239,68,68,0.05);">
                                    <td><strong>사망 시 수령액</strong></td>
                                    <td class="bank-col">${fmtUsd(bank.finalUsd)} (예금잔액)</td>
                                    <td class="etf-col">${fmtUsd(etf.finalUsd)} (ETF잔액)</td>
                                    <td class="ins-col" style="color:#999;">적립금 = ${fmtUsd(ins.totalUnits + (ins.additionalTotalCompounded || 0))} (전환 후)</td>
                                </tr>`;
                            }
                            const deathKrw = db.maxBenefit * ins.finalRate;
                            return `<tr style="background: rgba(239,68,68,0.05);">
                                <td><strong>사망 시 수령액</strong></td>
                                <td class="bank-col">${fmtUsd(bank.finalUsd)} (예금잔액)</td>
                                <td class="etf-col">${fmtUsd(etf.finalUsd)} (ETF잔액)</td>
                                <td class="ins-col" style="color:#ef4444; font-weight:700;">$${fmt(Math.round(db.maxBenefit))} (${fmt(Math.round(deathKrw))}원)</td>
                            </tr>`;
                        })() : ''}
                    </tbody>
                </table>
            </div>
        </div>`;

        container.innerHTML = html;
    }

    // ========================
    // 탭/UI 유틸
    // ========================
    showTab(tabName) {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        // event.target 대신 안전한 방법
        const tabs = document.querySelectorAll('.tab');
        tabs.forEach(t => { if (t.dataset.tab === tabName) t.classList.add('active'); });
        const content = document.getElementById(tabName + 'Tab');
        if (content) content.classList.add('active');
        if (tabName === 'chart') {
            if (this.chart) setTimeout(() => this.chart.resize(), 100);
            if (this.macdChart) setTimeout(() => this.macdChart.resize(), 100);
        }
        if (tabName === 'comparison') {
            if (this.comparisonChart) setTimeout(() => this.comparisonChart.resize(), 100);
        }
    }

    updateLastUpdateTime() {
        const last = this.exchangeRateData.length > 0
            ? this.exchangeRateData[this.exchangeRateData.length - 1].date.toISOString().split('T')[0].replace(/-/g, '.')
            : '?';
        const sourceLabel = this.apiSource ? '실시간' : '과거 데이터';
        const el = document.getElementById('lastUpdate');
        el.textContent = `환율 기준: ${last} (${sourceLabel})`;
        el.style.color = this.apiSource ? 'var(--color-success)' : 'var(--color-gray-400)';
        el.style.fontWeight = '600';
    }

    showLoading() {
        const el = document.getElementById('metricsGrid');
        if (el) el.innerHTML = '<div class="loading"><div class="spinner"></div>계산 중...</div>';
    }

    showError(message) {
        const el = document.getElementById('metricsGrid');
        if (el) el.innerHTML = `<div class="error">${message}</div>`;
        const banner = document.getElementById('summaryBanner');
        if (banner) banner.style.display = 'none';
    }
}

// ========================
// 전역 함수 (HTML onclick)
// ========================
let simulator;
window.addEventListener('DOMContentLoaded', () => {
    simulator = new DollarInvestmentSimulator();
    // URL 파라미터 자동인증 시도
    simulator.tryAutoAuth();
});

function authenticate() { simulator.authenticate(); }
function updateSimulation() { simulator.updateSimulation(); }
function showTab(tabName) { simulator.showTab(tabName); }
function calculateTarget() { simulator.calculateTarget(); }
function downloadConfig() { simulator.downloadConfig(); }
function shareAsUrl() { simulator.shareAsUrl(); }
function exportPdf() { simulator.exportPdf(); }
function exportResultImage() { simulator.exportResultImage(); }
function uploadConfig(event) { simulator.uploadConfig(event); }
function applyPreset(type, event) { simulator.applyPreset(type, event); }
function toggleAdditionalPremium() { simulator.toggleAdditionalPremium(); }
function toggleSidebar() { simulator.toggleSidebar(); }
function exportAsImage() { simulator.exportAsImage(); }
function toggleFullscreen(id) { simulator.toggleFullscreen(id); }
function exportAsCSV() { simulator.exportAsCSV(); }
function setQuickValue(inputId, value) {
    document.getElementById(inputId).value = value;
    if (inputId === 'dollarPremium') simulator.toggleDollarPremiumFields();
    simulator.updateSimulation();
}
function moveDate(amount, unit) {
    const el = document.getElementById('endDate');
    const d = new Date(el.value);
    if (isNaN(d)) return;
    if (unit === 'month') d.setMonth(d.getMonth() + amount);
    else d.setDate(d.getDate() + amount);
    el.value = d.toISOString().split('T')[0];
    simulator.updateSimulation();
}
function updateComparison() {
    if (simulator && simulator.lastResult) {
        simulator.updateComparisonTab(simulator.lastResult);
    }
}
function togglePtMode() {
    document.body.classList.toggle('pt-mode');
    const isPt = document.body.classList.contains('pt-mode');
    const icon = document.getElementById('ptModeIcon');
    if (icon) {
        icon.innerHTML = isPt
            ? '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'
            : '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>';
    }
    const btn = document.getElementById('ptModeBtn');
    if (btn) btn.title = isPt ? '일반 모드로 돌아가기' : '프레젠테이션 모드';
    if (simulator.chart) setTimeout(() => simulator.chart.resize(), 100);
    if (simulator.macdChart) setTimeout(() => simulator.macdChart.resize(), 100);
}
function toggleAdvancedSettings() {
    const ids = ['advancedPremiumSettings', 'advancedRateSettings'];
    const btn = document.getElementById('advancedToggleBtn');
    const isHidden = document.getElementById('advancedPremiumSettings').style.display === 'none';
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = isHidden ? 'block' : 'none';
    });
    btn.textContent = isHidden ? '⚙ 상세 설정 접기 ▴' : '⚙ 상세 설정 보기 ▾';
}
function updateEtfTaxRate() {
    const type = document.getElementById('etfAccountType')?.value;
    const taxInput = document.getElementById('etfTaxRate');
    if (!taxInput) return;
    const rates = { general: 15.4, isa: 9.9, pension: 3.3 };
    taxInput.value = rates[type] || 15.4;
    updateComparison();
}
