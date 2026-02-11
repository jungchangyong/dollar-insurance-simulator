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
            short: { totalPeriodYears: 3, interval: 'monthly', dollarPremium: 200, fixedPaymentMultiplier: 110, purchasePeriodYears: 2, holdingPeriodYears: 1, interestRate: 0, compoundRate: 0, reserveInterestRate: 3.25, additionalPremium: 0, additionalPremiumLimitPct: 200 },
            standard: { totalPeriodYears: 10, interval: 'monthly', dollarPremium: 300, fixedPaymentMultiplier: 110, purchasePeriodYears: 7, holdingPeriodYears: 3, interestRate: 24.8, compoundRate: 4.3, reserveInterestRate: 3.25, additionalPremium: 0, additionalPremiumLimitPct: 200 },
            long: { totalPeriodYears: 20, interval: 'monthly', dollarPremium: 500, fixedPaymentMultiplier: 110, purchasePeriodYears: 10, holdingPeriodYears: 5, interestRate: 24.8, compoundRate: 4.3, reserveInterestRate: 3.25, additionalPremium: 200, additionalPremiumLimitPct: 200 }
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
    authenticate() {
        const passwordInput = document.getElementById('passwordInput');
        const authError = document.getElementById('authError');
        if (passwordInput.value === this.PASSWORD) {
            this.authenticated = true;
            document.getElementById('authOverlay').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';
            this.initialize();
        } else {
            authError.innerHTML = '<div class="error">암호가 틀렸습니다.</div>';
        }
    }

    async initialize() {
        this.updateLastUpdateTime();
        await this.loadExchangeRateData();
        this.initPeriodSlider();
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
    async loadExchangeRateData() {
        if (this.csvLoaded && this.exchangeRateData.length > 0) return;
        try {
            // 1) CSV 로드 (과거 데이터)
            await this.loadCsvData();
            // 2) API로 최신 데이터 병합
            await this.fetchApiData();
            this.lastUpdate = new Date();
            this.updateLastUpdateTime();
        } catch (error) {
            console.error('환율 데이터 로드 실패:', error);
            // CSV만이라도 있으면 계속 동작
            if (this.exchangeRateData.length > 0) {
                console.warn('API 연결 실패, CSV 데이터만 사용합니다.');
                this.lastUpdate = new Date();
                this.updateLastUpdateTime();
            } else {
                this.showError('환율 데이터를 불러올 수 없습니다. 로컬 서버에서 실행해주세요: python -m http.server 8080');
            }
        }
    }

    async loadCsvData() {
        if (window.location.protocol === 'file:') {
            throw new Error('file:// 프로토콜에서는 CSV를 로드할 수 없습니다. python -m http.server 8080 으로 실행해주세요.');
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
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
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
            const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) });
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
            this.updateSummaryBanner(result);
            this.updateResultsTab(result);
            this.updateTimeline(result);
            this.updateChartTab(result);
            this.updateScheduleTab(result);
            this.updatePeriodInfo();
        } catch (error) {
            console.error('시뮬레이션 오류:', error);
            this.showError(`시뮬레이션 오류: ${error.message}`);
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
            additionalPremium: parseFloat(document.getElementById('additionalPremium').value) || 0,
            additionalPremiumFee: 0,  // 사업비 없음
            additionalPremiumLimitPct: parseFloat(document.getElementById('additionalPremiumLimitPct').value) || 200
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

        // 평균 매입 환율 (총 원화 / 총 달러 자산)
        const totalDollarPosition = basicPremiumTotal + finalReserveBalance;
        const finalAveragePrice = totalDollarPosition > 0 ? totalInvestment / totalDollarPosition : 0;

        // ========================
        // 저축전환 후 추가납입
        // ========================
        const additionalPremium = config.additionalPremium || 0;
        const additionalFeeRate = 0;  // 사업비 없음
        const additionalLimitPct = (config.additionalPremiumLimitPct || 200) / 100;
        let additionalHistory = [];
        let additionalTotalKrw = 0;
        let additionalTotalDollars = 0;  // 복리 전 순적립 합계
        let additionalTotalCompounded = 0;  // 복리 후 합계
        let additionalLimitReachedDate = null;

        if (additionalPremium > 0 && conversionPeriodYears > 0) {
            // 한도 계산: 해약환급금 × 한도비율 (저축전환의 기본보험료 = 해약환급금)
            const totalLimit = totalBeforeConversion * additionalLimitPct;

            // 저축전환 기간 월별 날짜 생성
            const conversionStart = new Date(holdingEndDate);
            const conversionMonths = Math.round(conversionPeriodYears * 12);
            let cumulativeAdditional = 0;

            for (let m = 0; m < conversionMonths; m++) {
                const date = new Date(conversionStart);
                date.setMonth(date.getMonth() + m);
                if (date >= endDate) break;

                // 한도 체크
                if (cumulativeAdditional >= totalLimit) {
                    if (!additionalLimitReachedDate) {
                        additionalLimitReachedDate = new Date(date);
                    }
                    break;
                }

                // 실제 납입 가능 금액 (총 한도 초과 방지, 월별 제한 없음)
                let actualPremium = additionalPremium;
                if (cumulativeAdditional + actualPremium > totalLimit) {
                    actualPremium = totalLimit - cumulativeAdditional;
                }
                if (actualPremium <= 0) continue;

                // 사업비 없음 (전액 적립)
                const fee = 0;
                const netDollars = actualPremium;

                // 환율 조회
                const rate = this.findClosestRate(date);
                const krwPaid = actualPremium * rate;

                // 잔여 저축전환 기간에 대한 복리
                const remainingYears = conversionPeriodYears - (m / 12);
                const compounded = remainingYears > 0
                    ? netDollars * Math.pow(1 + config.compoundRate / 100, remainingYears)
                    : netDollars;

                cumulativeAdditional += actualPremium;
                additionalTotalKrw += krwPaid;
                additionalTotalDollars += netDollars;
                additionalTotalCompounded += compounded;

                additionalHistory.push({
                    date: new Date(date),
                    rate,
                    premium: actualPremium,
                    fee,
                    netDollars,
                    compounded,
                    krwPaid,
                    cumulative: cumulativeAdditional,
                    totalLimit
                });
            }
        }

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
            basicTotalInvestment: totalInvestment,  // 기본납입 원화만
            config
        };
    }

    findClosestRate(targetDate) {
        const data = this.exchangeRateData;
        let lo = 0, hi = data.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (data[mid].date < targetDate) lo = mid + 1;
            else hi = mid;
        }
        if (lo === 0) return data[0].rate;
        const prev = data[lo - 1], curr = data[lo];
        return (Math.abs(curr.date - targetDate) < Math.abs(prev.date - targetDate))
            ? curr.rate : prev.rate;
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

        let text = `${intervalKo} ${Math.round(result.fixedKrw).toLocaleString()}원 고정납입 (보험료 $${cfg.dollarPremium}, 할증 ${cfg.fixedPaymentMultiplier}%) × ${cfg.purchasePeriodYears}년 → 총 $${Math.round(result.totalDollarPurchased).toLocaleString()} 납입, 적립금 $${Math.round(result.finalReserveBalance).toLocaleString()}`;
        if (result.additionalHistory.length > 0) {
            text += `, 추가납입 $${cfg.additionalPremium}/월 × ${result.additionalHistory.length}회 → $${Math.round(result.additionalTotalCompounded).toLocaleString()}`;
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
                    <span>+ 추가납입 (복리 후, ${result.additionalHistory.length}회)</span>
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
        grid.innerHTML = html;
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
        document.getElementById('additionalPremium').value = p.additionalPremium || 0;
        // additionalPremiumFee 제거됨 (사업비 없음)
        document.getElementById('additionalPremiumLimitPct').value = p.additionalPremiumLimitPct || 200;
        this.toggleDollarPremiumFields();
        this.validatePeriods();
        this.updateSimulation();
    }

    toggleDollarPremiumFields() {
        const conversionYears = parseFloat(document.getElementById('timeRange').value)
            - parseFloat(document.getElementById('purchasePeriod').value)
            - parseFloat(document.getElementById('holdingPeriod').value);
        const showAdditional = conversionYears > 0;
        // 추가납입 섹션 표시/숨김
        const ids = ['additionalPremiumSection', 'additionalPremiumGroup', 'additionalPremiumLimitGroup'];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = showAdditional ? 'block' : 'none';
        });
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

        // 평균 매입 환율을 만기일까지 연장 (납입 이후에도 손익 영역 표시)
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
                    callback: function(value) {
                        const d = new Date(value);
                        return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0');
                    },
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
                            callback: function(value) {
                                const d = new Date(value);
                                return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0');
                            },
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
                        <th>원화환산</th><th>누적($)</th><th>만기시 가치($)</th>
                    </tr></thead><tbody>`;
            result.additionalHistory.forEach((h, i) => {
                addHtml += `<tr class="additional">
                    <td>${i + 1}</td>
                    <td>${h.date.toISOString().split('T')[0]}</td>
                    <td>${h.rate.toFixed(2)}</td>
                    <td>$${h.premium.toFixed(2)}</td>
                    <td>${Math.round(h.krwPaid).toLocaleString()}</td>
                    <td>$${h.cumulative.toFixed(2)}</td>
                    <td>$${h.compounded.toFixed(2)}</td>
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
                    { name: '보수적', interestRate: 0, compoundRate: 0 },
                    { name: '안정', interestRate: 10, compoundRate: 2 },
                    { name: '표준', interestRate: currentSim.config.interestRate, compoundRate: currentSim.config.compoundRate },
                    { name: '적극적', interestRate: 30, compoundRate: 5 },
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
        const blob = new Blob([JSON.stringify(config, null, 4)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'investment_config.json';
        link.click();
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
            additionalPremium: 'additionalPremium',
            additionalPremiumLimitPct: 'additionalPremiumLimitPct'
        };
        for (const [key, id] of Object.entries(map)) {
            if (config[key] !== undefined) {
                const el = document.getElementById(id);
                if (el) el.value = config[key];
            }
        }
        this.toggleDollarPremiumFields();
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
    }

    updateLastUpdateTime() {
        const now = new Date();
        const last = this.exchangeRateData.length > 0
            ? this.exchangeRateData[this.exchangeRateData.length - 1].date.toISOString().split('T')[0].replace(/-/g, '.')
            : '?';
        const source = this.apiSource
            ? `krw.csv + ${this.apiSource}`
            : 'krw.csv';
        document.getElementById('lastUpdate').textContent =
            `데이터: ${source} (1990.03 ~ ${last}) | ${now.toLocaleString('ko-KR')}`;
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
window.addEventListener('DOMContentLoaded', () => { simulator = new DollarInvestmentSimulator(); });

function authenticate() { simulator.authenticate(); }
function updateSimulation() { simulator.updateSimulation(); }
function showTab(tabName) { simulator.showTab(tabName); }
function calculateTarget() { simulator.calculateTarget(); }
function downloadConfig() { simulator.downloadConfig(); }
function uploadConfig(event) { simulator.uploadConfig(event); }
function applyPreset(type, event) { simulator.applyPreset(type, event); }
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
