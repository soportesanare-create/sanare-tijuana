/**
 * app.js
 * Lógica principal del Dashboard Monitor de Signos Vitales
 * 
 * INTEGRADOR DE BLUETOOTH REAL (Web Bluetooth API)
 * Este script intenta conectarse nativamente al reloj usando perfiles médicos estándar.
 * IMPORTANTE: Requiere usar Google Chrome o Microsoft Edge en tu PC y tener el BT encendido.
 */

// Elementos UI
const btnConnect = document.getElementById('btn-connect');
const btnTriggerScan = document.getElementById('btn-trigger-scan'); // Botón de Escaneo Manual
const statusIndicator = document.getElementById('status-indicator');
const deviceConnectionStateText = document.getElementById('device-connection-state');

// Oxímetro BT — elementos UI
const btnConnectOxi      = document.getElementById('btn-connect-oxi');
const oxiStatusIndicator = document.getElementById('oxi-status-indicator');
const oxiStateHeader     = document.getElementById('oxi-connection-state-header');
const oxiStateCard       = document.getElementById('oxi-connection-state');
const oxiScreenValue     = document.getElementById('oximeter-screen-value');

// Valores de Tarjetas
const valSpo2 = document.getElementById('val-spo2');
const valHr = document.getElementById('val-hr');
const valPulse = document.getElementById('val-pulse');
const valBp = document.getElementById('val-bp'); 

const watchScreenValue = document.getElementById('watch-screen-value');
const valLastSync = document.getElementById('val-lastsync');
const alertsList = document.getElementById('alerts-list');

// Elementos de Paciente Modal
const modalOverlay = document.getElementById('patient-modal');
const patientForm = document.getElementById('patient-form');
const patientInfoCard = document.getElementById('patient-info-card');
const displayPName = document.getElementById('display-p-name');
const displayDName = document.getElementById('display-d-name');
const displayPDetails = document.getElementById('display-p-details');
const avatarInitial = document.getElementById('avatar-initial');
const btnSaveRecord = document.getElementById('btn-save-database');

// Estado — Pulsera
let bluetoothDevice = null;
let gattServer = null;
let hrCharacteristic = null;
let isConnected = false;
let currentPatient = null; 
let currentMeasurements = { hr: 0, spo2: 0, pulse: 0, bpSys: 0, bpDia: 0, temp: 0 }; 
let simulationInterval = null;

// Estado — Oxímetro
let oxiDevice = null;
let oxiGatt   = null;
let oxiChar   = null;
let isOxiConnected = false;
let sessionHistory = [];

let chartData = { labels: [], hr: [], spo2: [] };
const MAX_DATA_POINTS = 20;
let myChart = null;

// ============================================
// CONFIGURACIÓN FIREBASE (ACTUALIZADA)
// ============================================
const firebaseConfig = {
  apiKey: "AIzaSyCgDVwcleLUkFro-2yRTy2clO6yELNAdeY",
  authDomain: "pulsera-8d57c.firebaseapp.com",
  projectId: "pulsera-8d57c",
  storageBucket: "pulsera-8d57c.firebasestorage.app",
  messagingSenderId: "151967913471",
  appId: "1:151967913471:web:b894df1d2595f740b3c3ca"
};

// Inicializar Firebase (Compat Mode) con seguridad
if (typeof firebase !== 'undefined') {
  firebase.initializeApp(firebaseConfig);
} else {
  console.error("Firebase SDK no se cargó correctamente. Revisa la conexión a internet o el orden de los scripts.");
}
const db = (typeof firebase !== 'undefined') ? firebase.firestore() : null;

// Inicialización
document.addEventListener('DOMContentLoaded', () => {
  initChart();
  
  // Abrir Modal al querer conectar
  btnConnect.addEventListener('click', async () => {
    if(!isConnected) {
      if (!currentPatient) {
        modalOverlay.classList.add('active'); // Pedir datos del paciente primero
      } else {
        await connectRealBluetoothDevice(); // Si ya hay paciente, ir directo a conectar
      }
    } else {
      disconnectDevice();
    }
  });

  // ── Botón Oxímetro BT ────────────────────────────────────────────
  if (btnConnectOxi) {
    btnConnectOxi.addEventListener('click', async () => {
      if (!isOxiConnected) {
        await connectOximeter();
      } else {
        disconnectOximeter();
      }
    });
  }

  // Manejar el registro del paciente
  patientForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const pinAcceso = Math.floor(1000 + Math.random() * 9000).toString();

    // Extraer datos
    currentPatient = {
      doctorName: document.getElementById('d-name').value,
      name: document.getElementById('p-name').value,
      age: document.getElementById('p-age').value,
      id: document.getElementById('p-id').value.trim().toUpperCase() || 'SIN-CLAVE',
      pin: pinAcceso
    };

    // Actualizar UI del Paciente
    displayDName.innerText = currentPatient.doctorName;
    displayPName.innerText = currentPatient.name;
    displayPDetails.innerText = `${currentPatient.age} años | ${currentPatient.id}`;
    avatarInitial.innerText = currentPatient.name.charAt(0).toUpperCase();
    
    // Mostrar PIN en la interfaz
    const pinDisplay = document.getElementById('display-p-pin');
    if (pinDisplay) pinDisplay.innerText = pinAcceso;

    // Guardar/Actualizar en Firestore con confirmación
    // merge:true → actualiza solo los campos indicados, NO borra clinicalEvents existentes
    db.collection('patients').doc(currentPatient.pin).set({
      doctorName: currentPatient.doctorName,
      name: currentPatient.name,
      age: currentPatient.age,
      id: currentPatient.id,
      pin: currentPatient.pin,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      metrics: {
        hr: 0,
        spo2: 0,
        bpSys: 0,
        bpDia: 0
      }
    }, { merge: true })
    .then(() => {
      // Inicializar clinicalEvents solo si el documento es nuevo (no lo tiene aún)
      // Usamos set con merge para agregar el campo sin sobrescribir nada
      return db.collection('patients').doc(currentPatient.pin).set(
        { clinicalEvents: [] },
        { merge: true }
      );
    })
    .then(() => {
      console.log("Paciente guardado en Firestore con éxito. PIN:", currentPatient.pin);
      addAlert('success', `☁️ Sincronizado con la nube. PIN: ${currentPatient.pin}`);
    })
    .catch(err => {
      console.error("Error al guardar en Firestore:", err);
      addAlert('critical', `❌ Error de sincronización: ${err.message}`);
    });

    // Sincronizar localmente (para otras pestañas en la misma PC)
    localStorage.setItem('sanare_current_patient', JSON.stringify(currentPatient));

    // Mostrar Tarjeta, Esconder Modal
    patientInfoCard.classList.add('active');
    modalOverlay.classList.remove('active');

    addAlert('info', `Paciente ${currentPatient.name} registrado. Iniciando escaneo Bluetooth...`);
    
    // Iniciar Conexión Real
    await connectRealBluetoothDevice();
  });

  // Botón para guardar el registro en Base de Datos
  btnSaveRecord.addEventListener('click', () => {
    if(currentMeasurements.hr === 0) {
      alert("Aún no se reciben lecturas de la pulsera.");
      return;
    }

    addAlert('info', `✅ Registro guardado en el expediente de ${currentPatient.name}.`);
    btnSaveRecord.innerHTML = "¡Guardado exitosamente!";
    btnSaveRecord.style.backgroundColor = "#ecfdf5";
    btnSaveRecord.style.color = "#10b981";
    setTimeout(() => {
      btnSaveRecord.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
        Guardar Medición Actual`;
      btnSaveRecord.style.backgroundColor = "";
      btnSaveRecord.style.color = "";
    }, 3000);
  });

  // ── Presión Arterial — Edición Manual ────────────────────────────
  const btnEditBp  = document.getElementById('btn-edit-bp');
  const bpEditForm = document.getElementById('bp-edit-form');
  const btnSaveBp  = document.getElementById('btn-save-bp');
  const bpBadge    = document.getElementById('bp-badge');
  const bpClassEl  = document.getElementById('bp-classification');

  // Toggle formulario inline
  btnEditBp.addEventListener('click', () => {
    const isOpen = bpEditForm.classList.toggle('active');
    btnEditBp.innerHTML = isOpen
      ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Cancelar`
      : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Ingresar`;
    if (isOpen) document.getElementById('inp-bp-sys').focus();
  });

  // Guardar y clasificar la presión ingresada
  btnSaveBp.addEventListener('click', () => {
    const sys = parseInt(document.getElementById('inp-bp-sys').value, 10);
    const dia = parseInt(document.getElementById('inp-bp-dia').value, 10);

    if (!sys || !dia || sys < 60 || dia < 40) {
      document.getElementById('inp-bp-sys').style.borderColor = 'var(--accent-red)';
      document.getElementById('inp-bp-dia').style.borderColor = 'var(--accent-red)';
      return;
    }
    document.getElementById('inp-bp-sys').style.borderColor = '';
    document.getElementById('inp-bp-dia').style.borderColor = '';

    // Guardar en estado global
    currentMeasurements.bpSys = sys;
    currentMeasurements.bpDia = dia;

    // Actualizar tarjeta principal
    document.getElementById('val-bp').innerText = `${sys}/${dia}`;

    // Stream a Firestore
    if (currentPatient) {
      db.collection('patients').doc(currentPatient.pin).update({
        'metrics.bpSys': sys,
        'metrics.bpDia': dia,
        'metrics.lastUpdate': firebase.firestore.FieldValue.serverTimestamp()
      });
    }

    // Clasificación ACC/AHA 2017
    const { label, cls, icon } = classifyBP(sys, dia);
    bpBadge.className   = `badge ${cls}`;
    bpBadge.innerText   = label;
    bpClassEl.innerText = `${sys}/${dia} mmHg`;

    // Log de alertas
    const alertType = cls.includes('high2') || cls.includes('crisis') ? 'critical'
                    : cls.includes('high1') || cls.includes('elevated') ? 'warning' : 'info';
    addAlert(alertType, `${icon} PA manual registrada: ${sys}/${dia} mmHg — ${label}`);

    // Actualizar gráfica con el nuevo valor
    updateCharts(currentMeasurements,
      new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));

    // Cerrar formulario
    bpEditForm.classList.remove('active');
    btnEditBp.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Ingresar`;
  });

  // ── SpO2 — Edición Manual ────────────────────────────
  const btnEditSpo2  = document.getElementById('btn-edit-spo2');
  const spo2EditForm = document.getElementById('spo2-edit-form');
  const btnSaveSpo2  = document.getElementById('btn-save-spo2');
  const spo2Badge    = document.getElementById('spo2-badge');

  if (btnEditSpo2) {
    btnEditSpo2.addEventListener('click', () => {
      const isOpen = spo2EditForm.classList.toggle('active');
      btnEditSpo2.innerHTML = isOpen
        ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Cancelar`
        : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Ingresar`;
      if (isOpen) document.getElementById('inp-spo2').focus();
    });

    btnSaveSpo2.addEventListener('click', () => {
      const spo2Val = parseInt(document.getElementById('inp-spo2').value, 10);
      if (!spo2Val) return;
      currentMeasurements.spo2 = spo2Val;
      document.getElementById('val-spo2').innerText = spo2Val;
      
      if (currentPatient) {
        db.collection('patients').doc(currentPatient.pin).update({
          'metrics.spo2': spo2Val,
          'metrics.lastUpdate': firebase.firestore.FieldValue.serverTimestamp()
        });
      }

      spo2Badge.innerText = spo2Val >= 95 ? 'Normal' : 'Baja';
      spo2Badge.className = spo2Val >= 95 ? 'badge badge-normal' : 'badge badge-warning';
      addAlert(spo2Val >= 95 ? 'info' : 'warning', `SpO2 manual registrada: ${spo2Val}%`);
      
      updateCharts(currentMeasurements, new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      
      spo2EditForm.classList.remove('active');
      btnEditSpo2.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Ingresar`;
    });
  }

  // ── Temperatura — Edición Manual ────────────────────────────
  const btnEditTemp  = document.getElementById('btn-edit-temp');
  const tempEditForm = document.getElementById('temp-edit-form');
  const btnSaveTemp  = document.getElementById('btn-save-temp');
  const tempBadge    = document.getElementById('temp-badge');

  if (btnEditTemp) {
    btnEditTemp.addEventListener('click', () => {
      const isOpen = tempEditForm.classList.toggle('active');
      btnEditTemp.innerHTML = isOpen
        ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Cancelar`
        : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Ingresar`;
      if (isOpen) document.getElementById('inp-temp').focus();
    });

    btnSaveTemp.addEventListener('click', () => {
      const tempVal = parseFloat(document.getElementById('inp-temp').value);
      if (!tempVal) return;
      currentMeasurements.temp = tempVal;
      document.getElementById('val-temp').innerText = tempVal;
      
      if (currentPatient) {
        db.collection('patients').doc(currentPatient.pin).update({
          'metrics.temp': tempVal,
          'metrics.lastUpdate': firebase.firestore.FieldValue.serverTimestamp()
        });
      }

      let label = 'Normal';
      let cls = 'badge-bp-optimal';
      if (tempVal > 37.5) { label = 'Fiebre'; cls = 'badge-bp-high1'; }
      else if (tempVal < 35.0) { label = 'Hipotermia'; cls = 'badge-bp-elevated'; }
      
      tempBadge.innerText = label;
      tempBadge.className = `badge ${cls}`;
      addAlert(tempVal > 37.5 || tempVal < 35.0 ? 'warning' : 'info', `Temp manual registrada: ${tempVal}°C`);
      
      tempEditForm.classList.remove('active');
      btnEditTemp.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Ingresar`;
    });
  }

  // Lógica de "Monitoreo Continuo"
  // Con el Polar Verity Sense los datos llegan vía notificaciones BLE automáticamente.
  // Este botón solo muestra/oculta el estado activo en la UI.
  btnTriggerScan.addEventListener('click', async () => {
    if (!isConnected) {
      alert('⚠️ Primero debes Vincular Bluetooth a la pulsera Polar.');
      return;
    }

    if (simulationInterval) {
      // El usuario quiere pausar — detener notificaciones BLE
      clearInterval(simulationInterval);
      simulationInterval = null;
      if (hrCharacteristic) hrCharacteristic.stopNotifications().catch(() => {});
      btnTriggerScan.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
        </svg> Iniciar Monitoreo Continuo`;
      btnTriggerScan.style.backgroundColor = 'var(--accent-blue)';
      addAlert('warning', '⏸ Notificaciones BLE pausadas.');
    } else {
      // El usuario quiere reanudar — reactivar notificaciones BLE
      addAlert('info', '▶️ Activando telemetría BLE del Polar Verity Sense...');
      if (hrCharacteristic) {
        await hrCharacteristic.startNotifications().catch(err => addAlert('warning', `BLE: ${err.message}`));
      }
      simulationInterval = 1; // Bandera: indica que el monitoreo está activo
      btnTriggerScan.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg> Pausar Monitoreo`;
      btnTriggerScan.style.backgroundColor = 'var(--text-secondary)';
    }
  });

  // Lógica de Alerta Roja
  const btnTriggerAlert = document.getElementById('btn-trigger-alert');
  if (btnTriggerAlert) {
    btnTriggerAlert.addEventListener('click', () => {
      if (!currentPatient || !db) {
        alert('⚠️ Primero registra un paciente.');
        return;
      }
      const comentario = prompt("🚨 EMITIR ALERTA DE EMERGENCIA\nPor favor, describe brevemente qué ocurrió:");
      if (comentario) {
        const emergencyEvent = {
          type: 'emergency_alert',
          comentario: comentario,
          timestamp: new Date().toISOString(),
          timeStr: new Date().toLocaleTimeString()
        };

        db.collection('patients').doc(currentPatient.pin).update({
          clinicalEvents: firebase.firestore.FieldValue.arrayUnion(emergencyEvent)
        }).then(() => {
          addAlert('critical', `🚨 ALERTA EMITIDA: ${comentario}`);
        }).catch(err => {
          console.error("Error al emitir alerta:", err);
          alert('Error al emitir alerta: ' + err.message);
        });
      }
    });
  }

  // Guardado de historial local
  btnSaveRecord.addEventListener('click', () => {
    if(currentMeasurements.hr === 0) {
      alert("Aún no se reciben lecturas de la pulsera."); return;
    }

    // Insertar en tabla HTML directamente
    const timeStr = new Date().toLocaleTimeString();
    
    // Guardar en array de historial
    sessionHistory.push({
      time: timeStr,
      hr: currentMeasurements.hr,
      spo2: currentMeasurements.spo2,
      bpSys: currentMeasurements.bpSys,
      bpDia: currentMeasurements.bpDia,
      temp: currentMeasurements.temp || '--'
    });

    const tableBody = document.getElementById('history-table-body');
    const emptyMsg = document.getElementById('empty-history-msg');
    
    if (emptyMsg) emptyMsg.style.display = 'none';

    const row = document.createElement('tr');
    row.style.borderBottom = '1px solid var(--border-light)';
    row.innerHTML = `
      <td style="padding: 12px 8px;">${timeStr}</td>
      <td style="padding: 12px 8px; font-weight: 500;">${currentPatient.name}</td>
      <td style="padding: 12px 8px; color: var(--accent-red);">${currentMeasurements.hr}</td>
      <td style="padding: 12px 8px; color: var(--accent-blue);">${currentMeasurements.spo2}%</td>
      <td style="padding: 12px 8px; color: var(--accent-orange);">${currentMeasurements.bpSys}/${currentMeasurements.bpDia}</td>
      <td style="padding: 12px 8px; color: #f59e0b;">${currentMeasurements.temp || '--'}</td>
    `;
    tableBody.prepend(row);

    addAlert('info', `✅ Registro guardado en el expediente de ${currentPatient.name}.`);
    
    // Animación del botón
    btnSaveRecord.innerHTML = "¡Guardado exitosamente!";
    btnSaveRecord.style.backgroundColor = "#ecfdf5";
    btnSaveRecord.style.color = "#10b981";
    setTimeout(() => {
      btnSaveRecord.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
        Guardar Medición Actual`;
      btnSaveRecord.style.backgroundColor = "";
      btnSaveRecord.style.color = "";
    }, 2000);
  });

  // WhatsApp Share Logic
  const btnShareWhatsapp = document.getElementById('btn-share-whatsapp');
  if (btnShareWhatsapp) {
    btnShareWhatsapp.addEventListener('click', () => {
      if (!currentPatient) {
        alert("Aún no hay paciente registrado.");
        return;
      }
      if (sessionHistory.length === 0) {
        alert("No hay registros guardados en el historial de esta sesión.");
        return;
      }
      const pName = currentPatient.name || '--';
      const pDetails = `${currentPatient.age} años | ${currentPatient.id}`;
      
      let historyText = "";
      sessionHistory.forEach(r => {
        historyText += `[${r.time}] FC:${r.hr} | SpO2:${r.spo2}% | PA:${r.bpSys}/${r.bpDia} | T:${r.temp}°C\n`;
      });

      const message = `*Health Dashboard PRO - Historial de Sesión*\n` +
                      `Paciente: ${pName}\n` +
                      `Detalles: ${pDetails}\n\n` +
                      `*Registros capturados:*\n` +
                      historyText + `\n` +
                      `Generado el: ${new Date().toLocaleString()}`;

      const encodedMessage = encodeURIComponent(message);
      window.open(`https://wa.me/?text=${encodedMessage}`, '_blank');
      addAlert('success', 'Historial enviado por WhatsApp');
    });
  }

  // Descargar CSV Logic
  const btnDownloadCsv = document.getElementById('btn-download-csv');
  if (btnDownloadCsv) {
    btnDownloadCsv.addEventListener('click', () => {
      if (!currentPatient) {
        alert("Aún no hay paciente registrado.");
        return;
      }
      if (sessionHistory.length === 0) {
        alert("No hay registros en el historial para descargar.");
        return;
      }
      let csvContent = "data:text/csv;charset=utf-8,";
      csvContent += "Hora,Paciente,FC (bpm),SpO2 (%),Presion Sistolica (mmHg),Presion Diastolica (mmHg),Temp (C)\n";
      sessionHistory.forEach(r => {
        csvContent += `${r.time},${currentPatient.name},${r.hr},${r.spo2},${r.bpSys},${r.bpDia},${r.temp}\n`;
      });
      const encodedUri = encodeURI(csvContent);
      const link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      link.setAttribute("download", `Historial_Sanare_${currentPatient.name.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      addAlert('success', 'Historial descargado en formato CSV');
    });
  }

  // Lógica de Formularios de Infusión y Reacciones
  const btnSaveInfusion = document.getElementById('btn-save-infusion');
  if (btnSaveInfusion) {
    btnSaveInfusion.addEventListener('click', () => {
      if (!currentPatient || !db) {
        alert('⚠️ Primero registra un paciente (llena el formulario de nombre, edad y expediente). Sin paciente activo no se puede guardar.');
        return;
      }
      
      const sal = document.getElementById('inf-sal').value.trim();
      const gramos = document.getElementById('inf-gramos').value.trim();
      const dilucion = document.getElementById('inf-dilucion').value.trim();
      const tiempo = document.getElementById('inf-tiempo').value.trim();
      
      if (!sal) return alert('Por favor, ingresa el medicamento/sal.');

      const infusionEvent = {
        type: 'infusion',
        sal: sal,
        gramos: gramos,
        dilucion: dilucion,
        tiempo: tiempo,
        timestamp: new Date().toISOString(),
        timeStr: new Date().toLocaleTimeString()
      };

      db.collection('patients').doc(currentPatient.pin).update({
        clinicalEvents: firebase.firestore.FieldValue.arrayUnion(infusionEvent)
      }).then(() => {
        addAlert('info', '✅ Infusión registrada correctamente.');
        document.getElementById('inf-sal').value = '';
        document.getElementById('inf-gramos').value = '';
        document.getElementById('inf-dilucion').value = '';
        document.getElementById('inf-tiempo').value = '';
      }).catch(err => {
        console.error("Error al guardar infusión:", err);
        addAlert('critical', 'Error al guardar infusión: ' + err.message);
      });
    });
  }

  const btnSaveEvent = document.getElementById('btn-save-event');
  if (btnSaveEvent) {
    btnSaveEvent.addEventListener('click', () => {
      if (!currentPatient || !db) {
        alert('⚠️ Primero registra un paciente (llena el formulario de nombre, edad y expediente). Sin paciente activo no se puede guardar.');
        return;
      }
      
      const esperado = document.getElementById('evt-esperado').value.trim();
      const adversa = document.getElementById('evt-adversa').value.trim();
      const farmaco = document.getElementById('evt-farmaco').value.trim();

      if (!esperado && !adversa && !farmaco) return alert('Por favor, ingresa al menos un dato del evento.');

      const adverseEvent = {
        type: 'adverse_event',
        esperado: esperado,
        adversa: adversa,
        farmaco: farmaco,
        timestamp: new Date().toISOString(),
        timeStr: new Date().toLocaleTimeString()
      };

      db.collection('patients').doc(currentPatient.pin).update({
        clinicalEvents: firebase.firestore.FieldValue.arrayUnion(adverseEvent)
      }).then(() => {
        addAlert('warning', '⚠ Evento registrado correctamente.');
        document.getElementById('evt-esperado').value = '';
        document.getElementById('evt-adversa').value = '';
        document.getElementById('evt-farmaco').value = '';
      }).catch(err => {
        console.error("Error al guardar evento:", err);
        addAlert('critical', 'Error al guardar evento: ' + err.message);
      });
    });
  }

}); // <--- FIn de DOMContentLoaded


/**
 * Función que actualiza la data y domina las simulaciones/lógica
 */
function simulateWearFitResponse() {
  // Oscilación gradual
  currentMeasurements.hr = Math.max(60, Math.min(100, (currentMeasurements.hr || 75) + (Math.floor(Math.random() * 5) - 2)));
  if(Math.random() > 0.6) currentMeasurements.spo2 = Math.max(94, Math.min(100, (currentMeasurements.spo2 || 98) + (Math.floor(Math.random() * 3) - 1)));
  currentMeasurements.pulse = currentMeasurements.hr + (Math.floor(Math.random() * 2) - 1);
  if(Math.random() > 0.7) currentMeasurements.bpSys = Math.max(110, Math.min(130, (currentMeasurements.bpSys || 120) + (Math.floor(Math.random() * 5) - 2)));
  if(Math.random() > 0.7) currentMeasurements.bpDia = Math.max(70, Math.min(85, (currentMeasurements.bpDia || 80) + (Math.floor(Math.random() * 3) - 1)));

  document.getElementById('val-hr').innerText = currentMeasurements.hr;
  document.getElementById('val-spo2').innerText = currentMeasurements.spo2;
  document.getElementById('val-pulse').innerText = currentMeasurements.pulse;
  document.getElementById('val-bp').innerText = `${currentMeasurements.bpSys}/${currentMeasurements.bpDia}`;
  document.getElementById('watch-screen-value').innerText = currentMeasurements.hr;
  document.getElementById('val-lastsync').innerText = new Date().toLocaleTimeString();

  // Stream a Firestore (Simulación)
  if (currentPatient) {
    db.collection('patients').doc(currentPatient.pin).update({
      'metrics.hr': currentMeasurements.hr,
      'metrics.pulse': currentMeasurements.pulse,
      'metrics.spo2': currentMeasurements.spo2,
      'metrics.bpSys': currentMeasurements.bpSys,
      'metrics.bpDia': currentMeasurements.bpDia,
      'metrics.lastUpdate': firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  updateCharts(currentMeasurements, new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'}));
}

// ============================================
// CONEXIÓN REAL POR WEB BLUETOOTH API — POLAR VERITY SENSE
// ============================================
async function connectRealBluetoothDevice() {
  if (!navigator.bluetooth) {
    alert('❌ API Web Bluetooth no soportada. Usa Google Chrome o Microsoft Edge.');
    return;
  }
  try {
    btnConnect.innerHTML = '🔍 Buscando Polar...';
    addAlert('info', 'Escaneando dispositivos BLE cercanos...');

    // Solicitar dispositivo — filtro por nombre Polar + servicio Heart Rate estándar
    bluetoothDevice = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'Polar' },
        { services: [0x180D] }          // Heart Rate Service UUID
      ],
      optionalServices: [
        0x180D,  // Heart Rate
        0x180F,  // Battery Level
        0x180A,  // Device Information
        'battery_service'
      ]
    });

    addAlert('info', `Dispositivo encontrado: ${bluetoothDevice.name}. Conectando GATT...`);
    btnConnect.innerHTML = '⏳ Conectando...';

    gattServer = await bluetoothDevice.gatt.connect();

    // ── Servicio Heart Rate (0x180D) ──────────────────────────────────
    const hrService = await gattServer.getPrimaryService(0x180D);

    // Characteristic Heart Rate Measurement (0x2A37)
    hrCharacteristic = await hrService.getCharacteristic(0x2A37);

    // Suscribirse a notificaciones en tiempo real
    await hrCharacteristic.startNotifications();
    hrCharacteristic.addEventListener('characteristicvaluechanged', handleHeartRateData);

    // ── Batería (opcional, no bloquea si falla) ───────────────────────
    try {
      const batService  = await gattServer.getPrimaryService(0x180F);
      const batChar     = await batService.getCharacteristic(0x2A19);
      const batValue    = await batChar.readValue();
      const battPct     = batValue.getUint8(0);
      addAlert('info', `🔋 Batería del Polar: ${battPct}%`);
    } catch (_) { /* El dispositivo puede no exponer batería */ }

    // ── Actualizar UI ─────────────────────────────────────────────────
    isConnected = true;
    btnConnect.innerHTML = `✅ Polar Conectado`;
    btnConnect.classList.add('connected');
    statusIndicator.classList.add('active');
    deviceConnectionStateText.innerText = bluetoothDevice.name || 'Polar Verity Sense';
    addAlert('info', `🟢 HR real activo. Coloca el Polar en tu brazo y presiona Iniciar Monitoreo.`);

    bluetoothDevice.addEventListener('gattserverdisconnected', disconnectDevice);

  } catch (error) {
    console.error('[BLE Error]', error);
    if (error.name === 'NotFoundError') {
      addAlert('warning', '⚠️ No se seleccionó ningún dispositivo.');
    } else if (error.name === 'SecurityError') {
      addAlert('warning', '⚠️ Permiso denegado. Asegúrate de usar HTTPS o localhost.');
    } else {
      addAlert('warning', `❌ Error BLE: ${error.message}`);
    }
    disconnectDevice();
  }
}

// ============================================
// PARSER — Heart Rate Measurement (0x2A37)
// Especificación Bluetooth SIG:
//   Byte 0 = Flags
//     bit 0 → 0: HR en Uint8 | 1: HR en Uint16
//     bit 4 → 1: RR-Intervals presentes
//   Byte 1 (o 1-2) = Heart Rate Value
// ============================================
function handleHeartRateData(event) {
  const value  = event.target.value;   // DataView
  const flags  = value.getUint8(0);
  const hrFormat16 = flags & 0x01;     // bit 0

  const hrBpm = hrFormat16
    ? value.getUint16(1, /* littleEndian= */ true)
    : value.getUint8(1);

  // Actualizar medición actual con dato real
  currentMeasurements.hr    = hrBpm;
  currentMeasurements.pulse = hrBpm;   // Pulso = FC en este sensor

  // SpO2 y BP: el Polar Verity Sense OHR NO los transmite por BLE estándar
  // Se mantienen en su último valor o en placeholder
  if (currentMeasurements.spo2 === 0) currentMeasurements.spo2 = 98;
  if (currentMeasurements.bpSys === 0) { currentMeasurements.bpSys = 120; currentMeasurements.bpDia = 80; }

  // Actualizar UI
  document.getElementById('val-hr').innerText    = hrBpm;
  document.getElementById('val-pulse').innerText  = hrBpm;
  document.getElementById('watch-screen-value').innerText = hrBpm;
  document.getElementById('val-spo2').innerText   = currentMeasurements.spo2;
  document.getElementById('val-bp').innerText     = `${currentMeasurements.bpSys}/${currentMeasurements.bpDia}`;
  document.getElementById('val-lastsync').innerText = new Date().toLocaleTimeString();

  // Stream a Firestore
  if (currentPatient) {
    db.collection('patients').doc(currentPatient.pin).update({
      'metrics.hr': hrBpm,
      'metrics.pulse': hrBpm,
      'metrics.spo2': currentMeasurements.spo2,
      'metrics.lastUpdate': firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  updateCharts(currentMeasurements, new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
}

function disconnectDevice() {
  if (hrCharacteristic) {
    hrCharacteristic.removeEventListener('characteristicvaluechanged', handleHeartRateData);
    if (isConnected) hrCharacteristic.stopNotifications().catch(() => {});
    hrCharacteristic = null;
  }
  if (bluetoothDevice && bluetoothDevice.gatt.connected) bluetoothDevice.gatt.disconnect();
  isConnected = false;
  if (simulationInterval) { clearInterval(simulationInterval); simulationInterval = null; }
  btnConnect.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7l10 10M17 7L7 17"/></svg> Pulsera`;
  btnConnect.classList.remove('connected');
  statusIndicator.classList.remove('active');
  deviceConnectionStateText.innerText = 'Desconectado';
  addAlert('warning', 'Pulsera BLE desconectada.');
}

// ============================================================
// UUIDs BerryMed BM1000C (ISSC Transparent UART / Nordic-compatible)
// Modelo confirmado: Shanghai Berry Electronic Tech Co., Ltd. BM1000C
// ============================================================
const OXI_SERVICES = [
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // BerryMed ISSC Transparent UART (principal BM1000C)
  '0000ffe0-0000-1000-8000-00805f9b34fb', // BerryMed FFE0 (datos SpO2/PR)
  '0000ffe1-0000-1000-8000-00805f9b34fb', // BerryMed FFE1
  '0000ff12-0000-1000-8000-00805f9b34fb', // Genérico Oxímetro
  '0000fff0-0000-1000-8000-00805f9b34fb', // Genérico Oxímetro 2
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART Service
  '6e400002-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART TX
  '6e400003-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART RX
  0x1822, // PLX Continuous Measurement
  0x1820, // PLX Spot-Check Measurement
  0x180D, // Heart Rate Service
  0x180A, // Device Information
];

// Nombres BLE que puede anunciar el BerryMed BM1000C
const BERRY_NAME_PREFIXES = ['Berry', 'BM1000', 'Berrymed', 'berry', 'BerryMed', 'Oxi'];

async function connectOximeter() {
  if (!navigator.bluetooth) {
    alert('❌ Web Bluetooth no soportado. Usa Chrome o Edge.');
    return;
  }
  try {
    btnConnectOxi.innerHTML = '🔍 Buscando...';
    addAlert('info', '🫀 Buscando... Aparecerán todos los dispositivos cercanos.');

    // Pedimos TODOS los dispositivos para no fallar por culpa del nombre
    oxiDevice = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: OXI_SERVICES
    });

    addAlert('info', `📱 Dispositivo: "${oxiDevice.name || '(sin nombre)'}". Conectando GATT...`);
    oxiGatt = await oxiDevice.gatt.connect();

    let connected = false;

    // Auto-descubrimiento: intentar todos los servicios conocidos
    for (let uuid of OXI_SERVICES) {
      try {
        const svc = await oxiGatt.getPrimaryService(uuid);
        const chars = await svc.getCharacteristics();
        
        for (let char of chars) {
          if (char.properties.notify || char.properties.indicate) {
            await char.startNotifications();
            char.addEventListener('characteristicvaluechanged', handleRawOximeterData);
            connected = true;
            console.log(`[BT] Suscrito a notificaciones en: ${char.uuid}`);
            addAlert('info', `✅ Escuchando datos en: ${char.uuid.substring(0,8)}...`);
          }
        }
      } catch (err) {
        // El dispositivo no tiene este servicio específico (normal)
      }
    }

    if (!connected) {
      addAlert('warning',
        `⚠️ "${oxiDevice.name || 'Dispositivo'}" conectado pero no se encontró un canal de datos abierto.`
      );
    } else {
      addAlert('success', `📡 Conexión establecida. Pon el dedo en el oxímetro.`);
    }

    // UI
    isOxiConnected = true;
    btnConnectOxi.innerHTML = `✅ Oxímetro Conectado`;
    btnConnectOxi.classList.add('connected');
    oxiStatusIndicator.classList.add('active');
    if (oxiStateHeader) oxiStateHeader.innerText = oxiDevice.name || 'BT Oxímetro';
    if (oxiStateCard)   oxiStateCard.innerText   = connected ? 'Activo' : 'Sin datos';

    oxiDevice.addEventListener('gattserverdisconnected', disconnectOximeter);

  } catch (error) {
    console.error('[OXI BLE Error]', error);
    if (error.name === 'NotFoundError') {
      addAlert('warning', '⚠️ Oxímetro: no se seleccionó dispositivo.');
    } else {
      addAlert('warning', `❌ Oxímetro BLE: ${error.message}`);
    }
    disconnectOximeter();
  }
}

// ============================================================
// ENRUTADOR DE DATOS: Parser multi-protocolo para BerryMed BM1000C
// El BM1000C usa paquetes de 5 bytes por BLE UART:
//   Byte 0: Flags (bit7=1 indica inicio de trama)
//   Byte 1: SpO2 (%)
//   Byte 2: PR baja (LSB del pulso)
//   Byte 3: PR alta (MSB del pulso, bit 6)
//   Byte 4: Señal de onda
// ============================================================
let oxiPacketCount = 0;
let oxiBuffer = [];

function handleRawOximeterData(event) {
  const rawArray = new Uint8Array(event.target.value.buffer);
  
  // Diagnóstico: mostrar los primeros 5 paquetes para identificar el protocolo real
  if (oxiPacketCount < 5) {
    oxiPacketCount++;
    addAlert('info', `⚙️ BM1000C Raw[${oxiPacketCount}]: [${Array.from(rawArray).join(', ')}] (len=${rawArray.length})`);
  }

  // 1. PROTOCOLO BerryMed BM1000C — 5 bytes, byte 0 con bit 7 = 1
  // [StatusByte | SpO2 | PRLow | PRHigh+Flags | WaveformByte]
  // Acumular en buffer y buscar tramas válidas
  for (let i = 0; i < rawArray.length; i++) {
    oxiBuffer.push(rawArray[i]);
  }

  while (oxiBuffer.length >= 5) {
    // Sincronizar: el primer byte de la trama tiene bit 7 en 1
    if ((oxiBuffer[0] & 0x80) === 0) {
      oxiBuffer.shift();
      continue;
    }

    const b0 = oxiBuffer[0];  // Status flags
    const b1 = oxiBuffer[1];  // SpO2 %
    const b2 = oxiBuffer[2];  // PR LSB
    const b3 = oxiBuffer[3];  // PR MSB (bit 6) + flags adicionales
    const b4 = oxiBuffer[4];  // Waveform

    oxiBuffer = oxiBuffer.slice(5);

    // Detectar si el dedo está insertado (bit 1 de b0 = 0 → dedo presente)
    const fingerOut = (b0 & 0x02) !== 0;
    if (fingerOut) {
      addAlert('warning', '👆 BM1000C: Coloca el dedo correctamente en el oxímetro.');
      continue;
    }

    // Extraer SpO2 y PR según protocolo BerryMed BM1000C
    let spo2  = b1 & 0x7F;                         // 7 bits de SpO2
    let pulse = ((b3 & 0x40) << 1) | (b2 & 0x7F); // PR de 8 bits

    // Validar rangos fisiológicos
    if (spo2 > 30 && spo2 <= 100 && pulse > 20 && pulse < 300) {
      applyOximeterReading(spo2, pulse);
      continue;
    }

    // Variante alternativa: algunos BM1000C invierten b1/b2
    spo2  = b2 & 0x7F;
    pulse = ((b3 & 0x40) << 1) | (b1 & 0x7F);
    if (spo2 > 30 && spo2 <= 100 && pulse > 20 && pulse < 300) {
      applyOximeterReading(spo2, pulse);
    }
  }

  // 2. PROTOCOLO Genérico FF AA (fallback para otros modelos)
  // Formato: [0xFF, 0xAA, Seq, Len, SpO2, PR, ...]
  for (let i = 0; i < rawArray.length - 5; i++) {
    if (rawArray[i] === 0xFF && rawArray[i+1] === 0xAA) {
      const spo2  = rawArray[i+4];
      const pulse = rawArray[i+5];
      if (spo2 > 30 && spo2 <= 100 && pulse > 30 && pulse < 300) {
        applyOximeterReading(spo2, pulse);
        return;
      }
    }
  }

  // 3. Estándar PLX Continuous (IEEE SFLOAT)
  if (rawArray.length >= 4 && (rawArray[0] & 0x80) === 0 && oxiBuffer.length === 0) {
    const flags = rawArray[0];
    function sfloat(offset) {
      const raw = (rawArray[offset+1] << 8) | rawArray[offset]; 
      const exp = raw >> 12;
      const mantissa = raw & 0x0FFF;
      const signedExp = exp >= 8 ? exp - 16 : exp;
      return mantissa * Math.pow(10, signedExp);
    }
    const s_spo2  = (flags & 0x01) ? Math.round(sfloat(1)) : null;
    const s_pulse = (flags & 0x02) ? Math.round(sfloat(3)) : null;

    if (s_spo2 || s_pulse) {
      applyOximeterReading(s_spo2, s_pulse);
    }
  }
}

// ============================================================
// Actualización unificada de UI + Firestore desde el oxímetro
// ============================================================
let lastOxiSync = 0;

function applyOximeterReading(spo2, pulse) {
  const timeLabel = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  if (spo2 !== null && spo2 > 0 && spo2 <= 100) {
    currentMeasurements.spo2 = spo2;

    // Tarjeta SpO2 principal
    const valSpo2El = document.getElementById('val-spo2');
    if (valSpo2El) valSpo2El.innerText = spo2;

    // Pantalla sidebar oxímetro
    if (oxiScreenValue) oxiScreenValue.innerText = spo2;

    // Badge
    const badge = document.getElementById('spo2-badge');
    if (badge) {
      badge.innerText = spo2 >= 95 ? 'Normal' : spo2 >= 90 ? 'Baja' : 'Crítica';
      badge.className = spo2 >= 95 ? 'badge badge-normal'
                      : spo2 >= 90 ? 'badge badge-warning'
                      : 'badge badge-alert';
    }
  }

  if (pulse !== null && pulse > 0 && pulse < 300) {
    currentMeasurements.pulse = pulse;
    const valPulseEl = document.getElementById('val-pulse');
    if (valPulseEl) valPulseEl.innerText = pulse;
  }

  // LIMITADOR (Throttling): Actualizar Gráficos y Firebase solo 1 vez por segundo
  // El oxímetro puede enviar hasta 50 paquetes por segundo.
  const now = Date.now();
  if (now - lastOxiSync >= 1000) {
    lastOxiSync = now;
    
    document.getElementById('val-lastsync').innerText = timeLabel;

    // Guardar en Firestore
    if (currentPatient && db) {
      db.collection('patients').doc(currentPatient.pin).update({
        'metrics.spo2': currentMeasurements.spo2,
        'metrics.pulse': currentMeasurements.pulse, // Guardamos el pulso del oxi
        'metrics.lastUpdate': firebase.firestore.FieldValue.serverTimestamp()
      }).catch(e => console.error("Firebase update err:", e));
    }

    // Dibujar en los gráficos
    updateCharts(currentMeasurements, timeLabel);
  }
}

// ============================================================
// Desconexión limpia del oxímetro
// ============================================================
function disconnectOximeter() {
  if (oxiChar) {
    oxiChar.removeEventListener('characteristicvaluechanged', handleRawOximeterData);
    if (isOxiConnected) oxiChar.stopNotifications().catch(() => {});
    oxiChar = null;
  }
  if (oxiDevice && oxiDevice.gatt.connected) oxiDevice.gatt.disconnect();
  isOxiConnected = false;
  if (btnConnectOxi) {
    btnConnectOxi.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7l10 10M17 7L7 17"/></svg> Oxímetro`;
    btnConnectOxi.classList.remove('connected');
  }
  if (oxiStatusIndicator) oxiStatusIndicator.classList.remove('active');
  if (oxiStateHeader)     oxiStateHeader.innerText = 'Desconectado';
  if (oxiStateCard)       oxiStateCard.innerText   = 'Pendiente';
  if (oxiScreenValue)     oxiScreenValue.innerText = '--';
  addAlert('warning', 'Oxímetro BLE desconectado.');
}

let lastAlert = "";
function addAlert(type, message) {
  if (lastAlert === message) return;
  lastAlert = message;
  const timeStr = new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  const alertEl = document.createElement('div');
  alertEl.className = `alert-item ${type}`;
  alertEl.innerHTML = `<div class="alert-time">${timeStr}</div><div class="alert-msg">${message}</div>`;
  const list = document.getElementById('alerts-list');
  list.prepend(alertEl);
  if(list.children.length > 5) list.removeChild(list.lastChild);
}

// ============================================
// GRÁFICOS INDIVIDUALES - Chart.js
// ============================================
let chartHr, chartSpo2, chartBp;
let tLabels = [], dHr = [], dSpo2 = [], dBpSys = [], dBpDia = [];

function initChart() {
  const cHr = document.getElementById('chartHr');
  const cSpo2 = document.getElementById('chartSpo2');
  const cBp = document.getElementById('chartBp');
  const sharedOpts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false } } };

  if(cHr) {
    chartHr = new Chart(cHr.getContext('2d'), { type: 'line', data: { labels: tLabels, datasets: [{ data: dHr, borderColor: '#ef4444', tension: 0.3, borderWidth: 2 }] }, options: sharedOpts });
  }
  if(cSpo2) {
    chartSpo2 = new Chart(cSpo2.getContext('2d'), { type: 'line', data: { labels: tLabels, datasets: [{ data: dSpo2, borderColor: '#0ea5e9', tension: 0.3, borderWidth: 2 }] }, options: sharedOpts });
  }
  if(cBp) {
    chartBp = new Chart(cBp.getContext('2d'), { type: 'line', data: { labels: tLabels, datasets: [{ data: dBpSys, borderColor: '#f97316', label: 'Sys', tension: 0.2 }, { data: dBpDia, borderColor: '#fbbf24', label: 'Dia', tension: 0.2 }] }, options: { ...sharedOpts, plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 10, font: {size: 10} } } } } });
  }
}

function updateCharts(data, label) {
  if (tLabels.length >= 15) {
    tLabels.shift(); dHr.shift(); dSpo2.shift(); dBpSys.shift(); dBpDia.shift();
  }
  tLabels.push(label);
  dHr.push(data.hr);
  dSpo2.push(data.spo2);
  dBpSys.push(data.bpSys);
  dBpDia.push(data.bpDia);

  if(chartHr) chartHr.update();
  if(chartSpo2) chartSpo2.update();
  if(chartBp) chartBp.update();
}

// ============================================
// CLASIFICACIÓN DE PRESIÓN ARTERIAL
// Basado en guías ACC/AHA 2017
//   Óptima      : <120  / <80
//   Normal      : <130  / <80
//   Elevada     : 130-139 / 80-89
//   HTA Grado 1 : 140-159 / 90-99
//   HTA Grado 2 : ≥160   / ≥100
//   Crisis      : ≥180   / ≥120
// ============================================
function classifyBP(sys, dia) {
  if (sys >= 180 || dia >= 120) {
    return { label: 'Crisis Hipertensiva', cls: 'badge-bp-crisis',   icon: '🆘' };
  }
  if (sys >= 160 || dia >= 100) {
    return { label: 'HTA Grado 2',         cls: 'badge-bp-high2',   icon: '🔴' };
  }
  if (sys >= 140 || dia >= 90) {
    return { label: 'HTA Grado 1',         cls: 'badge-bp-high1',   icon: '🟠' };
  }
  if (sys >= 130 || dia >= 80) {
    return { label: 'Elevada',             cls: 'badge-bp-elevated', icon: '🟡' };
  }
  if (sys >= 120 && dia < 80) {
    return { label: 'Normal',              cls: 'badge-bp-normal',   icon: '🟢' };
  }
  return   { label: 'Óptima',             cls: 'badge-bp-optimal',  icon: '✅' };
}
