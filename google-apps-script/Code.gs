function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(data.environment || 'TEST');
    
    if (!sheet) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: 'Sheet not found'
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
    // Buscar si el piloto ya votó
    const dataRange = sheet.getDataRange();
    const values = dataRange.getValues();
    let rowIndex = -1;
    
    for (let i = 1; i < values.length; i++) {
      if (values[i][0] === data.pilot) {
        rowIndex = i + 1;
        break;
      }
    }
    
    const row = [
      data.pilot,
      JSON.stringify(data.days),
      JSON.stringify(data.times),
      data.timestamp
    ];
    
    if (rowIndex > 0) {
      // Actualizar voto existente
      sheet.getRange(rowIndex, 1, 1, 4).setValues([row]);
    } else {
      // Agregar nuevo voto
      sheet.appendRow(row);
    }
    
    return ContentService.createTextOutput(JSON.stringify({
      success: true
    })).setMimeType(ContentService.MimeType.JSON);
    
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  try {
    const environment = e.parameter.environment || 'TEST';
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(environment);
    
    if (!sheet) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: 'Sheet not found'
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
    const dataRange = sheet.getDataRange();
    const values = dataRange.getValues();
    
    // Saltar header
    const votes = values.slice(1).map(row => ({
      pilot: row[0],
      days: JSON.parse(row[1] || '[]'),
      times: JSON.parse(row[2] || '[]'),
      timestamp: parseInt(row[3] || '0')
    }));
    
    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      votes: votes
    })).setMimeType(ContentService.MimeType.JSON);
    
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}