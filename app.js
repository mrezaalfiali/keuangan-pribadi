const STORAGE_KEY = "transaksi-keuangan-pribadi";
const THEME_KEY = "theme-preference";

const themeToggle = document.getElementById("theme-toggle");
const themeToggleKnob = themeToggle ? themeToggle.querySelector(".theme-toggle-knob") : null;

const formTransaksi = document.getElementById("form-transaksi");
const formTitle = document.getElementById("form-title");
const btnCancelEdit = document.getElementById("btn-batal");
const btnSubmit = document.getElementById("btn-tambah");
const daftarTransaksi = document.getElementById("daftar-transaksi");
const emptyMessage = document.getElementById("empty-message");
const totalSaldo = document.getElementById("total-saldo");
const totalPemasukan = document.getElementById("total-pemasukan");
const totalPengeluaran = document.getElementById("total-pengeluaran");
const btnHapusSemua = document.getElementById("btn-hapus-semua");
const filterBulan = document.getElementById("filter-bulan");
const filterTahun = document.getElementById("filter-tahun");
const filterKategori = document.getElementById("filter-kategori");
const btnResetFilter = document.getElementById("btn-reset-filter");
const btnExportData = document.getElementById("btn-export-data");
const btnImportData = document.getElementById("btn-import-data");
const inputImportData = document.getElementById("input-import-data");
const filteredSaldo = document.getElementById("filtered-saldo");
const filteredPemasukan = document.getElementById("filtered-pemasukan");
const filteredPengeluaran = document.getElementById("filtered-pengeluaran");
const filteredCount = document.getElementById("filtered-count");
const chartCanvas = document.getElementById("chart-transaksi");

let transaksi = loadTransactions();
let editingId = null;
let filters = {
    bulan: "semua",
    tahun: "semua",
    kategori: "semua",
};

const categoryIcons = {
    gaji: "💰",
    bonus: "🎁",
    usaha: "💼",
    makanan: "🍽️",
    transportasi: "🚗",
    belanja: "🛒",
    tagihan: "📄",
    hiburan: "🎬",
    lainnya: "📌"
};

function loadTheme() {
    const savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme === "dark") {
        document.body.classList.add("dark-mode");
        updateThemeIcon(true);
    } else {
        document.body.classList.remove("dark-mode");
        updateThemeIcon(false);
    }
}

function toggleTheme() {
    const isDark = document.body.classList.toggle("dark-mode");
    localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
    updateThemeIcon(isDark);
    renderChart();
}

function updateThemeIcon(isDark) {
    if (themeToggleKnob) {
        themeToggleKnob.textContent = isDark ? "🌙" : "☀️";
    }
}

function loadTransactions() {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];
    try {
        return JSON.parse(data);
    } catch (error) {
        console.error("Gagal membaca data:", error);
        return [];
    }
}

function saveTransactions() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(transaksi));
}

function formatRupiah(angka) {
    return "Rp " + angka.toLocaleString("id-ID");
}

function getFilteredTransactions() {
    return transaksi.filter(function (item) {
        const itemDate = new Date(item.tanggal + "T00:00:00");
        const itemYear = itemDate.getFullYear();
        const itemMonth = itemDate.getMonth() + 1;

        if (filters.bulan !== "semua" && itemMonth !== Number(filters.bulan)) {
            return false;
        }

        if (filters.tahun !== "semua" && itemYear !== Number(filters.tahun)) {
            return false;
        }

        if (filters.kategori !== "semua" && item.kategori !== filters.kategori) {
            return false;
        }

        return true;
    });
}

function updateFilterOptions() {
    const years = [...new Set(transaksi.map(function (item) {
        return new Date(item.tanggal + "T00:00:00").getFullYear();
    }))].sort(function (a, b) {
        return b - a;
    });

    const selectedYear = filters.tahun;
    filterTahun.innerHTML = '<option value="semua">Semua Tahun</option>';

    for (const year of years) {
        const option = document.createElement("option");
        option.value = String(year);
        option.textContent = String(year);
        filterTahun.appendChild(option);
    }

    if (years.length === 0) {
        const currentYear = new Date().getFullYear();
        const option = document.createElement("option");
        option.value = String(currentYear);
        option.textContent = String(currentYear);
        filterTahun.appendChild(option);
    }

    if (selectedYear !== "semua" && !years.includes(Number(selectedYear))) {
        filters.tahun = "semua";
    }
}

function syncFilterControls() {
    filterBulan.value = filters.bulan;
    filterTahun.value = filters.tahun;
    filterKategori.value = filters.kategori;
}

function getChartData() {
    const year = filters.tahun !== "semua" ? Number(filters.tahun) : new Date().getFullYear();
    const months = filters.bulan !== "semua" ? [Number(filters.bulan)] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const sourceTransactions = getFilteredTransactions();
    const labels = months.map(function (month) {
        return new Date(year, month - 1, 1).toLocaleDateString("id-ID", { month: "short" });
    });
    const income = months.map(function (month) {
        return sourceTransactions.reduce(function (total, item) {
            const itemDate = new Date(item.tanggal + "T00:00:00");
            if (item.jenis === "pemasukan" && itemDate.getFullYear() === year && itemDate.getMonth() + 1 === month) {
                return total + item.jumlah;
            }
            return total;
        }, 0);
    });
    const expense = months.map(function (month) {
        return sourceTransactions.reduce(function (total, item) {
            const itemDate = new Date(item.tanggal + "T00:00:00");
            if (item.jenis === "pengeluaran" && itemDate.getFullYear() === year && itemDate.getMonth() + 1 === month) {
                return total + item.jumlah;
            }
            return total;
        }, 0);
    });
    return { labels: labels, income: income, expense: expense };
}

function isDarkMode() {
    return document.body.classList.contains("dark-mode");
}

function roundRect(ctx, x, y, width, height, radius) {
    if (height === 0) return;
    radius = Math.min(radius, height / 2, width / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height);
    ctx.lineTo(x, y + height);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fill();
}

let chartAnimationId = null;

function renderChart() {
    if (!chartCanvas) return;
    const context = chartCanvas.getContext("2d");
    if (!context) return;

    const container = chartCanvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    
    chartCanvas.width = rect.width * dpr;
    chartCanvas.height = rect.height * dpr;
    chartCanvas.style.width = rect.width + "px";
    chartCanvas.style.height = rect.height + "px";
    context.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const padding = { top: 24, right: 24, bottom: 44, left: 64 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const { labels, income, expense } = getChartData();
    const maxValue = Math.max(...income.concat(expense), 1);
    const groupWidth = chartWidth / labels.length;

    const dark = isDarkMode();
    const colors = {
        bg: dark ? "#1a1d27" : "#f8f9fa",
        grid: dark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.05)",
        text: dark ? "#9ca3af" : "#6b7280",
        income: dark ? "#34d399" : "#10b981",
        incomeGradientStart: dark ? "#34d399" : "#10b981",
        incomeGradientEnd: dark ? "#6ee7b7" : "#34d399",
        expense: dark ? "#f87171" : "#ef4444",
        expenseGradientStart: dark ? "#f87171" : "#ef4444",
        expenseGradientEnd: dark ? "#fca5a5" : "#f87171"
    };

    function drawFrame(progress) {
        context.clearRect(0, 0, width, height);
        context.fillStyle = colors.bg;
        context.fillRect(0, 0, width, height);

        context.strokeStyle = colors.grid;
        context.lineWidth = 1;
        context.setLineDash([4, 4]);
        for (let i = 0; i <= 4; i++) {
            const y = padding.top + (chartHeight / 4) * i;
            context.beginPath();
            context.moveTo(padding.left, y);
            context.lineTo(width - padding.right, y);
            context.stroke();

            const value = Math.round(maxValue - (maxValue / 4) * i);
            context.fillStyle = colors.text;
            context.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
            context.textAlign = "right";
            context.fillText(formatRupiah(value), padding.left - 10, y + 4);
        }
        context.setLineDash([]);

        const barWidth = Math.min(Math.max(20, groupWidth * 0.22), 44);
        const gap = Math.min(barWidth * 0.35, 10);
        const cornerRadius = Math.min(8, barWidth / 2.5);

        labels.forEach(function (label, index) {
            const x = padding.left + groupWidth * index + (groupWidth - barWidth * 2 - gap) / 2;
            
            const incomeValue = income[index] * progress;
            const expenseValue = expense[index] * progress;
            
            const incomeHeight = (incomeValue / maxValue) * chartHeight;
            const expenseHeight = (expenseValue / maxValue) * chartHeight;
            
            const incomeY = padding.top + chartHeight - incomeHeight;
            const expenseY = padding.top + chartHeight - expenseHeight;

            if (incomeHeight > 0) {
                const incomeGrad = context.createLinearGradient(x, incomeY, x, padding.top + chartHeight);
                incomeGrad.addColorStop(0, colors.incomeGradientStart);
                incomeGrad.addColorStop(1, colors.incomeGradientEnd);
                context.fillStyle = incomeGrad;
                roundRect(context, x, incomeY, barWidth, incomeHeight, cornerRadius);
                
                context.shadowColor = colors.income;
                context.shadowBlur = 8;
                context.shadowOffsetY = 4;
                roundRect(context, x, incomeY, barWidth, incomeHeight, cornerRadius);
                context.shadowColor = "transparent";
                context.shadowBlur = 0;
                context.shadowOffsetY = 0;
            }
            
            if (expenseHeight > 0) {
                const expenseGrad = context.createLinearGradient(x + barWidth + gap, expenseY, x + barWidth + gap, padding.top + chartHeight);
                expenseGrad.addColorStop(0, colors.expenseGradientStart);
                expenseGrad.addColorStop(1, colors.expenseGradientEnd);
                context.fillStyle = expenseGrad;
                roundRect(context, x + barWidth + gap, expenseY, barWidth, expenseHeight, cornerRadius);
                
                context.shadowColor = colors.expense;
                context.shadowBlur = 8;
                context.shadowOffsetY = 4;
                roundRect(context, x + barWidth + gap, expenseY, barWidth, expenseHeight, cornerRadius);
                context.shadowColor = "transparent";
                context.shadowBlur = 0;
                context.shadowOffsetY = 0;
            }

            context.fillStyle = colors.text;
            context.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
            context.textAlign = "center";
            context.fillText(label, x + barWidth + gap / 2, height - padding.bottom + 20);
        });
    }

    if (chartAnimationId) {
        cancelAnimationFrame(chartAnimationId);
    }

    const startTime = performance.now();
    const duration = 800;

    function animate(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 4);
        
        drawFrame(eased);
        
        if (progress < 1) {
            chartAnimationId = requestAnimationFrame(animate);
        }
    }

    chartAnimationId = requestAnimationFrame(animate);
}

function renderTransactions() {
    updateFilterOptions();
    syncFilterControls();

    const visibleTransactions = getFilteredTransactions();
    daftarTransaksi.innerHTML = "";

    if (transaksi.length === 0) {
        emptyMessage.style.display = "block";
        emptyMessage.querySelector(".empty-text").textContent = "Belum ada transaksi. Tambahkan transaksi pertama Anda!";
    } else if (visibleTransactions.length === 0) {
        emptyMessage.style.display = "block";
        emptyMessage.querySelector(".empty-text").textContent = "Tidak ada transaksi yang sesuai dengan filter yang dipilih.";
    } else {
        emptyMessage.style.display = "none";
    }

    const sorted = [...visibleTransactions].sort(function (a, b) {
        return b.tanggal.localeCompare(a.tanggal) || b.id - a.id;
    });

    const ul = document.createElement("ul");
    ul.className = "transaction-list";

    for (const item of sorted) {
        const li = document.createElement("li");
        li.className = "transaction-item slide-in";

        const icon = document.createElement("div");
        icon.className = "transaction-icon";
        icon.textContent = categoryIcons[item.kategori] || categoryIcons.lainnya;

        const details = document.createElement("div");
        details.className = "transaction-details";

        const nama = document.createElement("div");
        nama.className = "transaction-name";
        nama.textContent = item.nama;

        const meta = document.createElement("div");
        meta.className = "transaction-meta";
        const tanggal = new Date(item.tanggal + "T00:00:00").toLocaleDateString("id-ID", {
            day: "numeric",
            month: "short",
            year: "numeric",
        });
        const badge = document.createElement("span");
        badge.className = "transaction-badge";
        badge.textContent = item.kategori;
        meta.appendChild(document.createTextNode(tanggal + " "));
        meta.appendChild(badge);

        details.appendChild(nama);
        details.appendChild(meta);

        const amount = document.createElement("div");
        amount.className = "transaction-amount " + item.jenis;
        const tanda = item.jenis === "pemasukan" ? "+" : "-";
        amount.textContent = tanda + formatRupiah(item.jumlah);

        const actionGroup = document.createElement("div");
        actionGroup.className = "transaction-actions";

        const btnEdit = document.createElement("button");
        btnEdit.className = "btn-icon btn-edit";
        btnEdit.type = "button";
        btnEdit.textContent = "✏️";
        btnEdit.title = "Edit";
        btnEdit.addEventListener("click", function () {
            editTransaction(item.id);
        });

        const btnDelete = document.createElement("button");
        btnDelete.className = "btn-icon btn-delete";
        btnDelete.type = "button";
        btnDelete.textContent = "🗑️";
        btnDelete.title = "Hapus";
        btnDelete.addEventListener("click", function () {
            deleteTransaction(item.id);
        });

        actionGroup.appendChild(btnEdit);
        actionGroup.appendChild(btnDelete);

        li.appendChild(icon);
        li.appendChild(details);
        li.appendChild(amount);
        li.appendChild(actionGroup);
        ul.appendChild(li);
    }

    daftarTransaksi.appendChild(ul);
    renderSummary();
    renderFilteredSummary(visibleTransactions);
    renderChart();
}

function renderSummary() {
    let pemasukan = 0;
    let pengeluaran = 0;

    for (const item of transaksi) {
        if (item.jenis === "pemasukan") {
            pemasukan += item.jumlah;
        } else {
            pengeluaran += item.jumlah;
        }
    }

    totalPemasukan.textContent = formatRupiah(pemasukan);
    totalPengeluaran.textContent = formatRupiah(pengeluaran);
    totalSaldo.textContent = formatRupiah(pemasukan - pengeluaran);
}

function renderFilteredSummary(visibleTransactions) {
    let pemasukan = 0;
    let pengeluaran = 0;

    for (const item of visibleTransactions) {
        if (item.jenis === "pemasukan") {
            pemasukan += item.jumlah;
        } else {
            pengeluaran += item.jumlah;
        }
    }

    filteredPemasukan.textContent = formatRupiah(pemasukan);
    filteredPengeluaran.textContent = formatRupiah(pengeluaran);
    filteredSaldo.textContent = formatRupiah(pemasukan - pengeluaran);
    filteredCount.textContent = visibleTransactions.length;
}

function setEditMode(id) {
    editingId = id;
    if (id !== null) {
        formTitle.textContent = "Sunting Transaksi";
        btnSubmit.innerHTML = "<span>💾</span> Simpan";
        btnCancelEdit.style.display = "inline-flex";
    } else {
        formTitle.textContent = "Tambah Transaksi";
        btnSubmit.innerHTML = "<span>➕</span> Tambah";
        btnCancelEdit.style.display = "none";
    }
}

function resetForm() {
    formTransaksi.reset();
    document.getElementById("tanggal").value = new Date().toISOString().slice(0, 10);
    setEditMode(null);
}

function editTransaction(id) {
    const item = transaksi.find(function (transaction) {
        return transaction.id === id;
    });
    if (!item) return;

    document.getElementById("jenis").value = item.jenis;
    document.getElementById("nama").value = item.nama;
    document.getElementById("jumlah").value = item.jumlah;
    document.getElementById("tanggal").value = item.tanggal;
    document.getElementById("kategori").value = item.kategori;
    setEditMode(id);
    
    formTransaksi.scrollIntoView({ behavior: "smooth", block: "center" });
}

function addTransaction(event) {
    event.preventDefault();

    const nama = document.getElementById("nama").value.trim();
    const jumlah = Number(document.getElementById("jumlah").value);
    const jenis = document.getElementById("jenis").value;
    const tanggal = document.getElementById("tanggal").value;
    const kategori = document.getElementById("kategori").value;

    if (!nama || !jumlah || jumlah <= 0 || !tanggal) {
        alert("Mohon lengkapi semua data dengan benar.");
        return;
    }

    if (editingId !== null) {
        const index = transaksi.findIndex(function (item) {
            return item.id === editingId;
        });
        if (index !== -1) {
            transaksi[index] = {
                id: editingId,
                nama: nama,
                jumlah: jumlah,
                jenis: jenis,
                tanggal: tanggal,
                kategori: kategori,
            };
        }
        editingId = null;
    } else {
        const itemBaru = {
            id: Date.now(),
            nama: nama,
            jumlah: jumlah,
            jenis: jenis,
            tanggal: tanggal,
            kategori: kategori,
        };
        transaksi.push(itemBaru);
    }

    saveTransactions();
    renderTransactions();
    resetForm();
}

function deleteTransaction(id) {
    transaksi = transaksi.filter(function (item) {
        return item.id !== id;
    });
    if (editingId === id) {
        resetForm();
    }
    saveTransactions();
    renderTransactions();
}

function exportData() {
    const payload = {
        exportedAt: new Date().toISOString(),
        version: 1,
        transactions: transaksi,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "keuangan-pribadi-transaksi.json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function normalizeImportedTransactions(payload) {
    let source = payload;

    if (payload && typeof payload === "object") {
        if (Array.isArray(payload.transactions)) {
            source = payload.transactions;
        } else if (Array.isArray(payload.data)) {
            source = payload.data;
        }
    }

    if (!Array.isArray(source)) {
        throw new Error("Format file tidak valid.");
    }

    return source
        .filter(function (item) {
            return item && typeof item === "object";
        })
        .map(function (item, index) {
            const jumlah = Number(item.jumlah);
            const nama = String(item.nama || "").trim();
            const tanggal = String(item.tanggal || "").trim();
            const jenis = item.jenis === "pemasukan" ? "pemasukan" : "pengeluaran";
            const kategori = String(item.kategori || "lainnya").trim() || "lainnya";
            return {
                id: item.id || Date.now() + index,
                nama: nama,
                jumlah: Number.isFinite(jumlah) && jumlah > 0 ? jumlah : 0,
                jenis: jenis,
                tanggal: tanggal,
                kategori: kategori,
            };
        })
        .filter(function (item) {
            return item.nama && item.jumlah > 0 && item.tanggal;
        });
}

function importData(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const parsed = JSON.parse(e.target.result);
            const imported = normalizeImportedTransactions(parsed);

            if (imported.length === 0) {
                throw new Error("Tidak ada transaksi yang valid untuk diimpor.");
            }

            const yakin = confirm("Impor data ini akan menggantikan transaksi saat ini. Lanjutkan?");
            if (!yakin) {
                return;
            }

            transaksi = imported;
            saveTransactions();
            renderTransactions();
            resetForm();
            alert("Data berhasil diimpor.");
        } catch (error) {
            console.error("Gagal mengimpor data:", error);
            alert("Gagal mengimpor data: " + error.message);
        } finally {
            event.target.value = "";
        }
    };
    reader.readAsText(file);
}

function hapusSemua() {
    if (transaksi.length === 0) return;
    const yakin = confirm("Yakin ingin menghapus SEMUA transaksi?");
    if (yakin) {
        transaksi = [];
        resetForm();
        saveTransactions();
        renderTransactions();
    }
}

function applyFilters() {
    filters = {
        bulan: filterBulan.value,
        tahun: filterTahun.value,
        kategori: filterKategori.value,
    };
    renderTransactions();
}

function resetFilters() {
    filters = {
        bulan: "semua",
        tahun: "semua",
        kategori: "semua",
    };
    syncFilterControls();
    renderTransactions();
}

formTransaksi.addEventListener("submit", addTransaction);
btnHapusSemua.addEventListener("click", hapusSemua);
btnCancelEdit.addEventListener("click", resetForm);
filterBulan.addEventListener("change", applyFilters);
filterTahun.addEventListener("change", applyFilters);
filterKategori.addEventListener("change", applyFilters);
btnResetFilter.addEventListener("click", resetFilters);
btnExportData.addEventListener("click", exportData);
btnImportData.addEventListener("click", function () {
    inputImportData.click();
});
inputImportData.addEventListener("change", importData);

document.getElementById("tanggal").value = new Date().toISOString().slice(0, 10);
loadTheme();
renderTransactions();

if (themeToggle) {
    themeToggle.addEventListener("click", toggleTheme);
}

let resizeTimeout;
window.addEventListener("resize", function () {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(function () {
        renderChart();
    }, 150);
});