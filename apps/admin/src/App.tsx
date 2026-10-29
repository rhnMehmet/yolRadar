import { lazy, Suspense, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { getDamageTypeLabel, getReportStatusLabel } from '@roadsense/shared'
import { demoReports, damageTypes, formatReportDate, reportStatuses } from './data/reports'
import type { Report, ReportStatus } from './data/reports'
import { DamageMapBoundary } from './features/damage-map/DamageMapBoundary'
import './App.css'

const DamageMap = lazy(() => import('./features/damage-map/DamageMap'))
const VideoAnalysisPage = lazy(() => import('./features/video-analysis/VideoAnalysisPage'))
const ReviewPage = lazy(() => import('./features/review/ReviewPage'))

type Section = 'overview' | 'reports' | 'map' | 'statistics' | 'video' | 'review'
type IconName = 'grid' | 'list' | 'map' | 'chart' | 'arrow' | 'pin' | 'clock' | 'check' | 'layers' | 'search'

const navigation: { id: Section; label: string; icon: IconName }[] = [
  { id: 'overview', label: 'Genel Bakış', icon: 'grid' },
  { id: 'reports', label: 'Hasar Bildirimleri', icon: 'list' },
  { id: 'map', label: 'Hasar Haritası', icon: 'map' },
  { id: 'statistics', label: 'İstatistikler', icon: 'chart' },
  { id: 'video', label: 'Video Analizi', icon: 'layers' },
  { id: 'review', label: 'İnceleme', icon: 'check' },
]

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const shapes: Record<IconName, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    list: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
    map: <><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z" /><path d="M9 3v15M15 6v15" /></>,
    chart: <><path d="M4 3v17h17M9 15v-4M14 15V6M19 15V9" /></>,
    arrow: <path d="M4 12h15m-5-5 5 5-5 5" />,
    pin: <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    check: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
    layers: <><path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name]}</svg>
}

const statusClasses: Record<ReportStatus, string> = {
  new: 'new',
  in_review: 'review',
  resolved: 'resolved',
}

function StatusBadge({ status }: { status: ReportStatus }) {
  return <span className={`status-badge ${statusClasses[status]}`}><span />{getReportStatusLabel(status)}</span>
}

function ReportsTable({ reports }: { reports: readonly Report[] }) {
  return (
    <div className="table-scroll" role="region" aria-label="Örnek hasar bildirimleri tablosu" tabIndex={0}>
      <table>
        <caption className="sr-only">Demo kayıtlar; gerçek saha verisi değildir.</caption>
        <thead><tr><th scope="col">Bildirim ID</th><th scope="col">Hasar Türü</th><th scope="col">Konum</th><th scope="col">Tarih</th><th scope="col">Durum</th></tr></thead>
        <tbody>
          {reports.map((report) => (
            <tr key={report.id}>
              <td><span className="report-id">{report.id}</span></td>
              <td>{getDamageTypeLabel(report.damageType)}</td>
              <td><span className="location-name">{report.location}</span><span className="location-detail">Isparta Merkez</span></td>
              <td className="date-cell">{formatReportDate(report.date)}</td>
              <td><StatusBadge status={report.status} /></td>
            </tr>
          ))}
          {reports.length === 0 && <tr><td colSpan={5} className="empty-cell">Aramanızla eşleşen örnek bildirim bulunamadı.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

function App() {
  const [section, setSection] = useState<Section>('overview')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<ReportStatus | 'Tümü'>('Tümü')
  const currentSection = navigation.find((item) => item.id === section)!
  const countByStatus = (status: ReportStatus) => demoReports.filter((report) => report.status === status).length
  const resolvedPercent = Math.round((countByStatus('resolved') / demoReports.length) * 100)
  const normalizedQuery = query.trim().toLocaleLowerCase('tr-TR')
  const filteredReports = demoReports.filter((report) => (
    (statusFilter === 'Tümü' || report.status === statusFilter)
    && `${report.id} ${getDamageTypeLabel(report.damageType)} ${report.location}`.toLocaleLowerCase('tr-TR').includes(normalizedQuery)
  ))
  const metrics: { title: string; value: number; note: string; icon: IconName; tone: string }[] = [
    { title: 'Toplam Bildirim', value: demoReports.length, note: 'Örnek veri kümesindeki kayıtlar', icon: 'layers', tone: 'neutral' },
    { title: 'Yeni Bildirimler', value: countByStatus('new'), note: 'İnceleme bekleyen örnek kayıtlar', icon: 'list', tone: 'amber' },
    { title: 'İncelenen Bildirimler', value: countByStatus('in_review'), note: 'İnceleme sürecindeki örnek kayıtlar', icon: 'clock', tone: 'blue' },
    { title: 'Çözülen Bildirimler', value: countByStatus('resolved'), note: 'Tamamlanan örnek kayıtlar', icon: 'check', tone: 'green' },
  ]

  const distribution = (
    <section className="panel distribution-panel" aria-labelledby="distribution-title">
      <div className="panel-heading"><div><span className="section-kicker">ÖRNEK VERİLER</span><h2 id="distribution-title">Durum dağılımı</h2></div></div>
      <div className="completion-ring" role="img" aria-label={`Örnek bildirimlerin yüzde ${resolvedPercent} kadarı çözüldü.`} style={{ '--completed': `${(resolvedPercent / 100) * 360}deg` } as CSSProperties}>
        <div><strong>%{resolvedPercent}</strong><span>çözüm oranı</span></div>
      </div>
      <div className="distribution-legend">
        {reportStatuses.map((status) => <div key={status}><span><i className={`legend-dot ${statusClasses[status]}`} />{getReportStatusLabel(status)}</span><strong>{countByStatus(status)}<small> bildirim</small></strong></div>)}
      </div>
      <p className="chart-note">Oranlar yalnızca bu paneldeki demo kayıtlardan hesaplanır.</p>
    </section>
  )

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">İçeriğe geç</a>
      <aside className="sidebar" aria-label="Ana navigasyon">
        <div className="brand"><span className="brand-symbol"><i /><i /><i /></span><div><span className="brand-name">RoadSense<span>.</span></span><span className="brand-caption">YOL YÖNETİM SİSTEMİ</span></div></div>
        <div className="workspace-label">ÇALIŞMA ALANI</div>
        <nav aria-label="Yönetim paneli bölümleri">
          {navigation.map((item) => <button key={item.id} type="button" className={`nav-item ${section === item.id ? 'active' : ''}`} aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}><Icon name={item.icon} /><span>{item.label}</span>{section === item.id && <span className="active-dot" />}</button>)}
        </nav>
        <div className="sidebar-bottom"><div className="pilot-label"><Icon name="pin" /><div><strong>Isparta Merkez</strong><span>İlk pilot bölge</span></div></div><div className="sidebar-divider" /><p>DAHA İYİ YOLLAR,<br /><strong>DAHA GÜVENLİ YARINLAR.</strong></p><span className="sidebar-demo">RoadSense · Demo sürüm</span></div>
      </aside>

      <div className="workspace">
        <header className="topbar"><div className="breadcrumb">Çalışma alanı<span>/</span><strong>{currentSection.label}</strong></div><div className="topbar-meta"><span className="region-tag"><Icon name="pin" size={15} />Isparta</span><span className="demo-pill"><span />Demo çalışma alanı</span></div></header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          <div className="page-heading"><div><span className="section-kicker">YOL BAKIM VE TAKİP</span><h1>RoadSense Yönetim Paneli</h1><p>Yol hasarı bildirimlerini ve saha durumunu tek yerden yönetin.</p></div><span className="heading-symbol" aria-hidden="true"><Icon name="grid" size={26} /></span></div>

          <div className="demo-notice"><span className="notice-mark" aria-hidden="true">i</span><p><strong>Örnek veriler gösteriliyor.</strong> Tüm kayıtlar ve metrikler demo amaçlıdır; gerçek saha verisi içermez.</p></div>

          {section === 'overview' && <>
            <div className="section-heading"><h2>Genel Bakış</h2><span className="subtle-label">{demoReports.length} örnek kayıt · Isparta Merkez</span></div>
            <div className="metric-grid">{metrics.map((metric) => <section key={metric.title} className={`metric-card ${metric.tone}`} aria-label={metric.title}><div className="metric-top"><span>{metric.title}</span><span className="metric-icon"><Icon name={metric.icon} /></span></div><strong className="metric-value">{String(metric.value).padStart(2, '0')}</strong><p>{metric.note}</p></section>)}</div>
            <div className="overview-grid"><section className="panel"><div className="panel-heading"><div><span className="section-kicker">BİLDİRİM AKIŞI</span><h2>Son bildirimler</h2></div><button type="button" className="text-button" onClick={() => setSection('reports')}>Tüm bildirimler<Icon name="arrow" size={17} /></button></div><ReportsTable reports={demoReports.slice(0, 5)} /><div className="table-footer"><span>Son 5 örnek kayıt gösteriliyor</span><span className="live-note">Yerel demo verileri</span></div></section>{distribution}</div>
            <div className="pilot-note"><span className="pilot-icon"><Icon name="pin" size={22} /></span><div><strong>İlk adım: Isparta</strong><p>Yol hasarlarının görünür olduğu, bakım süreçlerinin birlikte takip edildiği bir kent için.</p></div><span className="pilot-note-label">PİLOT BÖLGE</span></div>
          </>}

          {section === 'reports' && <section className="panel reports-panel" aria-labelledby="reports-title"><div className="panel-heading"><div><span className="section-kicker">ÖRNEK KAYITLAR</span><h2 id="reports-title">Hasar Bildirimleri</h2></div><span className="record-count">{filteredReports.length} / {demoReports.length} kayıt</span></div><div className="table-filters"><label className="search-field"><Icon name="search" size={18} /><span className="sr-only">Bildirimlerde ara</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ID, hasar türü veya konum ara…" /></label><label className="status-filter"><span>Durum</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as ReportStatus | 'Tümü')}><option value="Tümü">Tüm durumlar</option>{reportStatuses.map((status) => <option key={status} value={status}>{getReportStatusLabel(status)}</option>)}</select></label></div><ReportsTable reports={filteredReports} /><div className="table-footer" aria-live="polite">{filteredReports.length} örnek bildirim gösteriliyor.</div></section>}

          {section === 'map' && (
            <DamageMapBoundary>
              <Suspense fallback={<div className="panel map-fallback" role="status">Harita hazırlanıyor…</div>}>
                <DamageMap />
              </Suspense>
            </DamageMapBoundary>
          )}

          {section === 'video' && <Suspense fallback={<div className="panel map-fallback" role="status">Video analizi hazırlanıyor…</div>}><VideoAnalysisPage /></Suspense>}
          {section === 'review' && <Suspense fallback={<div className="panel map-fallback" role="status">İnceleme hazırlanıyor…</div>}><ReviewPage /></Suspense>}

          {section === 'statistics' && <div className="statistics-grid"><section className="panel" aria-labelledby="stats-title"><div className="panel-heading"><div><span className="section-kicker">ÖRNEK VERİLER</span><h2 id="stats-title">Hasar türüne göre dağılım</h2></div><span className="record-count">{demoReports.length} kayıt</span></div><div className="damage-bars">{damageTypes.map((type) => { const count = demoReports.filter((report) => report.damageType === type).length; return <div className="damage-bar-row" key={type}><div><span>{getDamageTypeLabel(type)}</span><strong>{count}<small> bildirim</small></strong></div><div className="bar-track" role="img" aria-label={`${getDamageTypeLabel(type)}: ${count} örnek bildirim`}><span style={{ width: `${(count / demoReports.length) * 100}%` }} /></div></div> })}<p className="chart-note">Tüm hesaplamalar aynı örnek bildirim listesini kullanır.</p></div></section>{distribution}</div>}

          <footer className="page-footer"><span>© 2026 RoadSense</span><span>Yapay Zekâ Destekli Akıllı Yol Hasarı Haritası</span></footer>
        </main>
      </div>
    </div>
  )
}

export default App
