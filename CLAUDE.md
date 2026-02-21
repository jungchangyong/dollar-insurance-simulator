# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 응답 언어

**반드시 한국어로만 응답한다.** 코드 주석, 커밋 메시지, 사용자와의 대화 모두 한국어를 사용한다.

## 프로젝트 개요

달러종신보험 시뮬레이터 — USD/KRW 환율 기반 원화고정납입 보험 시뮬레이션 도구. HTML/JS 단일 버전.

## 실행 방법

```bash
cd krw
python -m http.server 8080
# http://localhost:8080/dollar_simulator.html 접속, 비밀번호: secret123
```

## 아키텍처

- **`krw/dollar_simulator.html` + `krw/dollar_simulator.js`** (~3,030줄) — 바닐라 JS + Chart.js. CSV(1990~2025.03) + Frankfurter API(ECB, 최신) 환율 데이터. localStorage 캐시.
- **`krw/krw.csv`** — 1990년부터의 KRW/USD 종가 환율 이력. 컬럼: `기간`(YYYY-MM-DD), `환율(종가)`. UTF-8 BOM.
- **`krw/index.html`** — 한국 상속세/증여세 세법 비교 테이블 (참고용, 시뮬레이터와 무관).

### 주요 내부 메서드 (리팩토링 후)

- `_runInvestmentSimulation(insuranceResult, options)` — 은행/ETF 공통 시뮬레이션 (납입→거치→전환 3단계). options: `{ monthlyRate, feeMultiplier, taxCalc }`
- `runBankSimulation` / `runEtfSimulation` — 위 공통함수의 래퍼 (파라미터만 다름)
- `_phaseSnapshot(history, phase)` — 기간별 스냅샷 (비교 테이블용)
- `findClosestIndex(targetDate)` — 이진 탐색 기본. `findClosestRate`는 이를 호출
- `_getDeathBenefitStatus(insuranceResult)` — 사망보험금 전환 상태 판별 (`{ afterConversion, maxBenefit }`)
- `_formatChartDate(value)` — Chart.js x축 날짜 포맷 (YYYY.MM)

## 핵심 시뮬레이션 로직

1. 납입기간 동안 납입주기(일/주/월/년)에 따라 매수 날짜 생성
2. 각 매수 날짜의 환율 조회 (이진 탐색)
3. 원화고정납입: 고정 원화 납입, 환율 차액은 적립금으로 관리
4. 거치기간: 적립금에 부리이율 연복리 적용
5. 거치 종료 시 약정이율 1회 적용
6. 저축전환 기간: 공시이율 연복리 적용, 추가납입 가능
7. 최종 자산 = 만기 USD × 만기환율
8. 목표 역산: 이분 탐색(최대 30회)

## 주요 제약사항

- CSV 데이터: 1990-03-02 ~ 2025-03, 이후는 Frankfurter API(ECB)로 자동 갱신
- `file://` 프로토콜 불가 — 반드시 HTTP 서버 필요
- 모든 UI 텍스트는 한국어
- 비밀번호 `secret123` 하드코딩

## 의존성

JS: Chart.js + chartjs-adapter-date-fns (CDN 로드)
