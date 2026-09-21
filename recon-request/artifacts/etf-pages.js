/**
 * Sortable columns for Distributions table
 */
document.addEventListener("DOMContentLoaded", function() {
    // Select all tables with the class "distribution-table-sortable"
    const tables = document.querySelectorAll(".distribution-table-sortable");

    // Loop through each table to set up independent sorting functionality
    tables.forEach((table) => {
        const tbody = table.querySelector("tbody");
        const headers = table.querySelectorAll(".distribution-table-th");
        let sortDirections = Array(headers.length).fill(false); // Track sort direction for each column within each table

        headers.forEach((header, index) => {
            header.addEventListener("click", () => {
                // Toggle the sort direction for the clicked column in this specific table
                sortDirections[index] = !sortDirections[index];
                sortTableByColumn(tbody, index, sortDirections[index]);

                // Update arrow direction for the current table's headers
                headers.forEach((hdr, i) => {
                    const arrow = hdr.querySelector(".sort-arrow");
                    if (arrow) arrow.innerHTML = i === index ? (sortDirections[index] ? '&#x25B2;' : '&#x25BC;') : '&#x25BC;';
                });
            });
        });
    });

    /**
     * Sorts rows in the specified table body based on the given column index and sort direction
     * @param {HTMLElement} tableBody - The tbody element of the table to sort
     * @param {number} columnIndex - The index of the column to sort by
     * @param {boolean} ascending - Sort direction; true for ascending, false for descending
     */
    function sortTableByColumn(tableBody, columnIndex, ascending = true) {
        const rows = Array.from(tableBody.querySelectorAll("tr"));

        const sortedRows = rows.sort((a, b) => {
            if (!a.cells[columnIndex] || !b.cells[columnIndex]) {
                console.error(`Row is missing the column at index ${columnIndex}`);
                return 0;
            }

            const aText = a.cells[columnIndex].textContent.trim();
            const bText = b.cells[columnIndex].textContent.trim();
            let comparison = 0;

            if (columnIndex === 4) { // Assuming column 4 contains numeric data
                const aAmount = parseFloat(aText.replace("$", "")) || 0;
                const bAmount = parseFloat(bText.replace("$", "")) || 0;
                comparison = aAmount - bAmount;
            } else { // Assuming other columns contain date data
                const aDate = new Date(aText);
                const bDate = new Date(bText);

                if (!isNaN(aDate) && !isNaN(bDate)) {
                    comparison = aDate - bDate;
                } else {
                    console.error(`Invalid date detected: "${aText}" or "${bText}"`);
                    return 0;
                }
            }

            return ascending ? comparison : -comparison;
        });

        // Clear the table body and re-append sorted rows
        while (tableBody.firstChild) {
            tableBody.removeChild(tableBody.firstChild);
        }
        tableBody.append(...sortedRows);
    }
});

/**
 * AJAX request to the download endpoint with ticker parameter
 */
function downloadHoldingsCSV(ticker) {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", `${etf_ajax.ajax_url}?action=download_holdings_csv&ticker=${ticker}`, true);
    xhr.responseType = 'blob'; // Important for file download

    xhr.onload = function () {
        if (xhr.status === 200) {
            // Create a link element, set it as the download URL, and click it programmatically
            const blob = new Blob([xhr.response], { type: 'text/csv' });
            const link = document.createElement('a');
            link.href = window.URL.createObjectURL(blob);
            link.download = `NEOS Holdings - ${ticker} Holdings.csv`;
            link.click();
            window.URL.revokeObjectURL(link.href); // Clean up URL object
        } else {
            alert("Error downloading file.");
        }
    };

    xhr.send();
}
