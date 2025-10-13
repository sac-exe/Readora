function fetchSuggestions() {
    const searchInput = document.getElementById('searchInput');
    const suggestionsList = document.getElementById('suggestionsList');
    const query = searchInput.value.trim();
  
    if (query.length === 0) {
      suggestionsList.style.display = 'none';
      suggestionsList.innerHTML = '';
      return;
    }
  
    fetch(`/search-suggestions?query=${encodeURIComponent(query)}`)
      .then((response) => {
        if (!response.ok) {
          throw new Error('Failed to fetch suggestions');
        }
        return response.json();
      })
      .then((data) => {
        suggestionsList.innerHTML = ''; // Clear previous suggestions
  
        if (data.length > 0) {
          data.forEach((place) => {
            const li = document.createElement('li');
            li.innerHTML = `
              <span>${place.Place}</span>
               
               
              <sub style="color: gray; font-size: 0.8em;">${place.Location || 'Unknown Location'}</sub>
              
            `;
            li.onclick = () => {
              
               const formattedPlaceName = place.Place.toLowerCase().replace(/\s+/g, '-');
              // Redirect to the explore page for the selected place
              window.location.href = `/user/explore/${formattedPlaceName}`;
              
              
            };
            suggestionsList.appendChild(li);
          });
          suggestionsList.style.display = 'block'; // Show suggestions
        } else {
          suggestionsList.style.display = 'none';
        }
      })
      .catch((error) => {
        console.error('Error fetching suggestions:', error);
      });
  }